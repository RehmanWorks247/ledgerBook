import { BadRequestException, Body, Controller, Get, Headers, Inject, Param, ParseIntPipe, ParseUUIDPipe, Post, Req, Res, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AccessService } from '../access/access.service';
import { SessionGuard } from '../auth/session.guard';
import { RateLimitService } from '../auth/rate-limit.service';
import { DocumentVersionsService } from './document-versions.service';
import { DocumentDownloadInterceptor } from './document-download.interceptor';
import { DocumentUploadInterceptor } from './document-upload.interceptor';
type AuthRequest=Request & {user:{id:string}};
@Controller('organizations/:orgId/customers/:customerId/bookings/:bookingId')
@UseGuards(SessionGuard)
export class DocumentVersionsController {
  constructor(@Inject(AccessService) private readonly access:AccessService,@Inject(DocumentVersionsService) private readonly versions:DocumentVersionsService,
    @Inject(RateLimitService) private readonly rate:RateLimitService) {}
  @Get('documents/:documentId/versions')
  async history(@Req() req:AuthRequest,@Param('orgId',ParseUUIDPipe) org:string,@Param('customerId',ParseUUIDPipe) customer:string,@Param('bookingId',ParseUUIDPipe) booking:string,@Param('documentId',ParseUUIDPipe) document:string) {
    return this.versions.history(await this.access.membership(req.user.id,org),customer,booking,document);
  }
  @Get('documents/:documentId/text')
  @UseInterceptors(DocumentDownloadInterceptor)
  async text(@Req() req:AuthRequest,@Param('orgId',ParseUUIDPipe) org:string,@Param('customerId',ParseUUIDPipe) customer:string,@Param('bookingId',ParseUUIDPipe) booking:string,@Param('documentId',ParseUUIDPipe) document:string,@Res({passthrough:true}) res:Response) {
    res.setHeader('Cache-Control','private, no-store');
    return this.versions.text(await this.access.membership(req.user.id,org,true),customer,booking,document);
  }
  @Get('documents/:documentId/versions/:version')
  @UseInterceptors(DocumentDownloadInterceptor)
  async download(@Req() req:AuthRequest,@Param('orgId',ParseUUIDPipe) org:string,@Param('customerId',ParseUUIDPipe) customer:string,@Param('bookingId',ParseUUIDPipe) booking:string,@Param('documentId',ParseUUIDPipe) document:string,@Param('version',ParseIntPipe) version:number,@Res() res:Response) {
    const file=await this.versions.download(await this.access.membership(req.user.id,org),customer,booking,document,version);
    const fallback=file.name.replace(/[^A-Za-z0-9 ._()-]/g,'_');
    const encoded=encodeURIComponent(file.name).replace(/[!'()*]/g,char=>`%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    res.setHeader('Content-Type',file.mimeType);res.setHeader('Content-Disposition',`attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`);
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','private, no-store');res.send(file.content);
  }
  @Post('documents/:documentId/versions/:version/restore')
  async restore(@Req() req:AuthRequest,@Param('orgId',ParseUUIDPipe) org:string,@Param('customerId',ParseUUIDPipe) customer:string,@Param('bookingId',ParseUUIDPipe) booking:string,@Param('documentId',ParseUUIDPipe) document:string,@Param('version',ParseIntPipe) version:number,@Body() body:unknown) {
    const member=await this.access.membership(req.user.id,org,true);await this.rate.consume('document-restore',req.user.id,120,3600);
    return this.versions.restore(member,customer,booking,document,version,body);
  }
  @Post('folders/:folderId/documents/:documentId/uploads')
  async begin(@Req() req:AuthRequest,@Param('orgId',ParseUUIDPipe) org:string,@Param('customerId',ParseUUIDPipe) customer:string,@Param('bookingId',ParseUUIDPipe) booking:string,@Param('folderId',ParseUUIDPipe) folder:string,@Param('documentId',ParseUUIDPipe) document:string,@Body() body:unknown) {
    const member=await this.access.membership(req.user.id,org,true);await this.rate.consume('document-upload-prepare',req.user.id,120,3600);
    return this.versions.begin(member,customer,booking,document,folder,body);
  }
  @Post('folders/:folderId/documents/:documentId/uploads/:uploadId/complete')
  @UseInterceptors(DocumentDownloadInterceptor)
  async complete(@Req() req:AuthRequest,@Param('orgId',ParseUUIDPipe) org:string,@Param('customerId',ParseUUIDPipe) customer:string,@Param('bookingId',ParseUUIDPipe) booking:string,@Param('folderId',ParseUUIDPipe) folder:string,@Param('documentId',ParseUUIDPipe) document:string,@Param('uploadId',ParseUUIDPipe) upload:string) {
    const member=await this.access.membership(req.user.id,org,true);await this.rate.consume('document-upload-complete',req.user.id,240,3600);
    return this.versions.complete(member,customer,booking,document,folder,upload);
  }
  @Post('folders/:folderId/documents/:documentId/content')
  @UseInterceptors(DocumentUploadInterceptor)
  async proxy(@Req() req:AuthRequest,@Param('orgId',ParseUUIDPipe) org:string,@Param('customerId',ParseUUIDPipe) customer:string,@Param('bookingId',ParseUUIDPipe) booking:string,@Param('folderId',ParseUUIDPipe) folder:string,@Param('documentId',ParseUUIDPipe) document:string,@Headers('x-file-name') encoded:string,@Headers('idempotency-key') key:string,@Headers('x-document-version') expected:string,@Body() body:unknown) {
    let name:string;try {name=decodeURIComponent(encoded??'');}catch {throw new BadRequestException('The document name is invalid.');}
    if(!/^\d+$/.test(expected??'')) throw new BadRequestException('Provide the document version being replaced.');
    return this.versions.proxy(await this.access.membership(req.user.id,org,true),customer,booking,document,folder,name,key,Number(expected),body);
  }
}
