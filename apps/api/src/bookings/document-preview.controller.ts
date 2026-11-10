import { Controller, Get, Inject, Param, ParseUUIDPipe, Req, Res, ServiceUnavailableException, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { AccessService } from '../access/access.service';
import { RateLimitService } from '../auth/rate-limit.service';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard';
import { BookingsService } from './bookings.service';
import { DocumentDownloadInterceptor } from './document-download.interceptor';
import { DocumentPreviewService } from './document-preview';

@Controller('organizations/:orgId/customers/:customerId/bookings/:bookingId/documents')
@UseGuards(SessionGuard)
export class DocumentPreviewController {
  constructor(@Inject(AccessService) private readonly access:AccessService,
    @Inject(BookingsService) private readonly bookings:BookingsService,
    @Inject(DocumentPreviewService) private readonly previews:DocumentPreviewService,
    @Inject(RateLimitService) private readonly rate:RateLimitService) {}

  @Get(':documentId/preview')
  @UseInterceptors(DocumentDownloadInterceptor)
  async preview(@Req() req:AuthenticatedRequest,@Param('orgId',ParseUUIDPipe) orgId:string,
    @Param('customerId',ParseUUIDPipe) customerId:string,@Param('bookingId',ParseUUIDPipe) bookingId:string,
    @Param('documentId',ParseUUIDPipe) documentId:string,@Res() res:Response) {
    res.setHeader('Cache-Control','private, no-store');
    const cancellation = new AbortController();
    const closed = () => cancellation.abort();
    res.once('close',closed);
    try {
      const member = await this.access.membership(req.user.id,orgId);
      await this.rate.consume('document-preview',req.user.id,120,3600);
      // Authorize and load the current version on every request. No derived
      // content is cached across a replacement, deletion or access change.
      const source = await this.bookings.document(member,customerId,bookingId,documentId);
      const preview = await this.previews.render(source,cancellation.signal);
      res.setHeader('Content-Type',preview.mimeType);
      res.setHeader('Content-Disposition',`inline; filename="preview.${preview.mode === 'text-only' ? 'txt' : 'png'}"`);
      res.setHeader('X-Document-Preview',preview.mode);
      res.setHeader('X-Content-Type-Options','nosniff');
      res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");
      res.send(preview.content);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) res.setHeader('Retry-After','5');
      throw error;
    } finally {
      res.off('close',closed);
    }
  }
}
