import {
  BadRequestException, type CallHandler, type ExecutionContext, Inject, Injectable,
  type NestInterceptor, PayloadTooLargeException, RequestTimeoutException,
  ServiceUnavailableException, UnsupportedMediaTypeException,
} from '@nestjs/common';
import express, { type Response } from 'express';
import { finalize, type Observable } from 'rxjs';
import { AccessService } from '../access/access.service';
import { RateLimitService } from '../auth/rate-limit.service';
import type { AuthenticatedRequest } from '../auth/session.guard';
import { UUID_PATTERN } from '../ledger/money';
import { BookingsService, MAX_DOCUMENT_BYTES } from './bookings.service';

const MAX_ACTIVE_UPLOADS = 8;
const UPLOAD_TIMEOUT_MS = 60_000;

/** SessionGuard runs first; file bytes are buffered only after destination authorization. */
@Injectable()
export class DocumentUploadInterceptor implements NestInterceptor {
  private activeUploads = 0;
  private readonly parseBody = express.raw({ type:['application/octet-stream','application/pdf'], limit:MAX_DOCUMENT_BYTES, inflate:false });

  constructor(@Inject(AccessService) private readonly access:AccessService,
    @Inject(BookingsService) private readonly bookings:BookingsService,
    @Inject(RateLimitService) private readonly rate:RateLimitService) {}

  async intercept(context:ExecutionContext, next:CallHandler):Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    const ids = ['orgId','customerId','bookingId','folderId'].map(key => String(request.params[key] ?? ''));
    if (ids.some(id => !UUID_PATTERN.test(id))) throw new BadRequestException('Select a valid booking and destination folder.');
    if (!request.is(['application/octet-stream','application/pdf'])) throw new UnsupportedMediaTypeException('Upload file bytes using application/octet-stream.');
    if ((request.get('content-encoding') ?? 'identity').toLowerCase() !== 'identity') {
      throw new UnsupportedMediaTypeException('Compressed upload requests are not supported.');
    }
    if (!UUID_PATTERN.test(request.get('idempotency-key') ?? '')) throw new BadRequestException('Provide a valid upload submission key.');
    let name:string;
    try { name = decodeURIComponent(request.get('x-file-name') ?? '').trim(); }
    catch { throw new BadRequestException('The document name is invalid.'); }
    if (!name || name.length > 240 || /[/\\]/.test(name) || name === '.' || name === '..' ||
      Array.from(name).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
      throw new BadRequestException('Choose a filename of at most 240 characters without a slash or control character.');
    }
    const length = request.get('content-length');
    if (length !== undefined) {
      if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))) throw new BadRequestException('The upload size is invalid.');
      if (Number(length) > MAX_DOCUMENT_BYTES) throw new PayloadTooLargeException('File uploads must be at most 10 MB.');
    }
    if (this.activeUploads >= MAX_ACTIVE_UPLOADS) {
      response.setHeader('Retry-After','5');
      throw new ServiceUnavailableException('The upload service is busy. Please retry in a few seconds.');
    }

    this.activeUploads++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.activeUploads--;
    };
    try {
      await this.rate.consume('document-upload',request.user.id,120,3600);
      const [orgId,customerId,bookingId,folderId] = ids;
      const member = await this.access.membership(request.user.id,orgId,true);
      await this.bookings.authorizeUpload(member,customerId,bookingId,folderId);
      await this.readBody(request,response);
      return next.handle().pipe(finalize(release));
    } catch (error) {
      release();
      throw error;
    }
  }

  private readBody(request:AuthenticatedRequest, response:Response):Promise<void> {
    return new Promise((resolve,reject) => {
      if (request.aborted || request.destroyed) {
        reject(new BadRequestException('The upload was interrupted. Please retry.'));
        return;
      }
      let settled = false;
      let received = 0;
      const cleanup = () => {
        clearTimeout(timer);
        request.off('aborted',aborted);
        request.off('error',aborted);
        request.off('data',countBytes);
      };
      const finish = (error?:unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error); else resolve();
      };
      // Stop buffering immediately, then allow the error response to flush before
      // closing an incomplete request. Destroying the socket first loses the 408/413.
      const stopReading = (error:unknown) => {
        if (settled) return;
        request.pause();
        response.setHeader('Connection','close');
        const close = () => {
          response.off('finish',close);
          response.off('close',close);
          request.destroy();
        };
        response.once('finish',close);
        response.once('close',close);
        finish(error);
      };
      const aborted = () => finish(new BadRequestException('The upload was interrupted. Please retry.'));
      const countBytes = (chunk:Buffer) => {
        received += chunk.length;
        if (received > MAX_DOCUMENT_BYTES) stopReading(new PayloadTooLargeException('File uploads must be at most 10 MB.'));
      };
      const timer = setTimeout(() => stopReading(new RequestTimeoutException('The upload timed out. Please retry.')),UPLOAD_TIMEOUT_MS);
      timer.unref();
      request.once('aborted',aborted);
      request.once('error',aborted);
      request.on('data',countBytes);
      try {
        this.parseBody(request,response,(error?:unknown) => {
          if (!error) { finish(); return; }
          const type = (error as {type?:string}).type;
          if (type === 'entity.too.large') finish(new PayloadTooLargeException('File uploads must be at most 10 MB.'));
          else if (type === 'encoding.unsupported') finish(new UnsupportedMediaTypeException('Compressed upload requests are not supported.'));
          else finish(new BadRequestException('The file upload could not be read. Please retry.'));
        });
      } catch { finish(new BadRequestException('The file upload could not be read. Please retry.')); }
    });
  }
}
