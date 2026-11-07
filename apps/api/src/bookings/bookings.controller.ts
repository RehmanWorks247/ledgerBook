import { BadRequestException, Body, Controller, Get, Headers, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AccessService } from '../access/access.service';
import { SessionGuard } from '../auth/session.guard';
import { RateLimitService } from '../auth/rate-limit.service';
import { BookingsService } from './bookings.service';
import { DocumentUploadInterceptor } from './document-upload.interceptor';
import { DocumentDownloadInterceptor } from './document-download.interceptor';
import { canPreviewDocument } from './document-files';

type AuthRequest = Request & {user:{id:string;email:string}};
@Controller('organizations/:orgId/customers/:customerId/bookings')
@UseGuards(SessionGuard)
export class BookingsController {
  constructor(@Inject(AccessService) private readonly access:AccessService,
    @Inject(BookingsService) private readonly bookings:BookingsService,
    @Inject(RateLimitService) private readonly rate:RateLimitService) {}

  @Get()
  async list(@Req() req:AuthRequest,@Param('orgId',ParseUUIDPipe) orgId:string,@Param('customerId',ParseUUIDPipe) customerId:string) {
    return this.bookings.list(await this.access.membership(req.user.id,orgId),customerId);
  }
  @Post()
  async create(@Req() req:AuthRequest,@Param('orgId',ParseUUIDPipe) orgId:string,@Param('customerId',ParseUUIDPipe) customerId:string,@Body() body:unknown) {
    await this.rate.consume('booking-create',req.user.id,60,3600);
    return this.bookings.create(await this.access.membership(req.user.id,orgId,true),customerId,body);
  }
  @Get(':bookingId')
  async get(@Req() req:AuthRequest,@Param('orgId',ParseUUIDPipe) orgId:string,@Param('customerId',ParseUUIDPipe) customerId:string,@Param('bookingId',ParseUUIDPipe) bookingId:string) {
    return this.bookings.get(await this.access.membership(req.user.id,orgId),customerId,bookingId);
  }
  @Get(':bookingId/files')
  async files(@Req() req:AuthRequest,@Param('orgId',ParseUUIDPipe) orgId:string,@Param('customerId',ParseUUIDPipe) customerId:string,@Param('bookingId',ParseUUIDPipe) bookingId:string) {
    return this.bookings.files(await this.access.membership(req.user.id,orgId),customerId,bookingId);
  }
  @Post(':bookingId/folders')
  async folder(@Req() req:AuthRequest,@Param('orgId',ParseUUIDPipe) orgId:string,@Param('customerId',ParseUUIDPipe) customerId:string,@Param('bookingId',ParseUUIDPipe) bookingId:string,@Body() body:unknown) {
    return this.bookings.createFolder(await this.access.membership(req.user.id,orgId,true),customerId,bookingId,body);
  }
  @Patch(':bookingId/files/:nodeId')
  async move(@Req() req:AuthRequest,@Param('orgId',ParseUUIDPipe) orgId:string,@Param('customerId',ParseUUIDPipe) customerId:string,@Param('bookingId',ParseUUIDPipe) bookingId:string,@Param('nodeId',ParseUUIDPipe) nodeId:string,@Body() body:unknown) {
    return this.bookings.move(await this.access.membership(req.user.id,orgId,true),customerId,bookingId,nodeId,body);
  }
  @Patch(':bookingId/services/:serviceKey')
  async issuance(@Req() req:AuthRequest,@Param('orgId',ParseUUIDPipe) orgId:string,@Param('customerId',ParseUUIDPipe) customerId:string,@Param('bookingId',ParseUUIDPipe) bookingId:string,@Param('serviceKey') serviceKey:string,@Body() body:unknown) {
    return this.bookings.issuance(await this.access.membership(req.user.id,orgId,true),customerId,bookingId,serviceKey,body);
  }
  @Post(':bookingId/folders/:folderId/documents')
  @UseInterceptors(DocumentUploadInterceptor)
  async upload(@Req() req:AuthRequest,@Param('orgId',ParseUUIDPipe) orgId:string,@Param('customerId',ParseUUIDPipe) customerId:string,@Param('bookingId',ParseUUIDPipe) bookingId:string,@Param('folderId',ParseUUIDPipe) folderId:string,@Headers('x-file-name') encodedName:string,@Headers('idempotency-key') key:string,@Body() body:unknown) {
    const member = await this.access.membership(req.user.id,orgId,true);
    let filename:string;
    try { filename = decodeURIComponent(encodedName ?? ''); }
    catch { throw new BadRequestException('The document name is invalid.'); }
    return this.bookings.upload(member,customerId,bookingId,folderId,filename,key,body);
  }
  @Get(':bookingId/documents/:documentId')
  @UseInterceptors(DocumentDownloadInterceptor)
  async document(@Req() req:AuthRequest,@Param('orgId',ParseUUIDPipe) orgId:string,@Param('customerId',ParseUUIDPipe) customerId:string,@Param('bookingId',ParseUUIDPipe) bookingId:string,@Param('documentId',ParseUUIDPipe) documentId:string,@Query('download') download:string|undefined,@Res() res:Response) {
    if (download !== undefined && download !== '1') throw new BadRequestException('Unsupported document download option.');
    const document = await this.bookings.document(await this.access.membership(req.user.id,orgId),customerId,bookingId,documentId);
    const fallback = document.name.replace(/[^A-Za-z0-9 ._()-]/g,'_');
    const encoded = encodeURIComponent(document.name).replace(/[!'()*]/g,char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    const inline = download !== '1' && canPreviewDocument(document.mimeType);
    res.setHeader('Content-Type',document.mimeType);
    res.setHeader('Content-Disposition',`${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encoded}`);
    if (inline && document.mimeType === 'application/pdf') {
      // Chromium's native PDF viewer can load the PDF through a synthetic
      // embed. Permit only that same-origin object on this authenticated PDF
      // response; preserve the application's script and framing restrictions.
      const policy = res.getHeader('Content-Security-Policy');
      if (typeof policy === 'string') res.setHeader('Content-Security-Policy',
        policy.replace(/(^|;\s*)object-src\s+'none'(?=;|$)/,"$1object-src 'self'"));
    }
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Cache-Control','private, no-store');
    res.send(document.content);
  }
}
