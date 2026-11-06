import { BadRequestException, Body, CanActivate, Controller, ExecutionContext, Get, Inject, Injectable, Param,
  ParseUUIDPipe, Post, Query, Req, Res, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { AccessService } from '../access/access.service';
import { RateLimitService } from '../auth/rate-limit.service';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard';
import { MAX_RECEIPT_BYTES, MAX_RECEIPTS, PaymentsService, type PaymentUpload } from './payments.service';

/** Guards run before Multer, so unauthorized uploads are rejected before buffering images. */
@Injectable()
export class PaymentUploadGuard implements CanActivate {
  constructor(@Inject(AccessService) private readonly access:AccessService,
    @Inject(PaymentsService) private readonly payments:PaymentsService,
    @Inject(RateLimitService) private readonly rate:RateLimitService) {}
  async canActivate(context:ExecutionContext) {
    const req=context.switchToHttp().getRequest<AuthenticatedRequest>();
    if(!req.is('multipart/form-data')) throw new BadRequestException('Upload payment receipts using multipart/form-data.');
    await this.rate.consume('payment-upload',req.user.id,30,3600);
    const member=await this.access.membership(req.user.id,String(req.params.orgId));
    await this.payments.authorizeUpload(member,String(req.params.customerId),String(req.params.bookingId));
    return true;
  }
}

@Controller('organizations/:orgId/customers/:customerId/bookings/:bookingId/payments')
@UseGuards(SessionGuard)
export class PaymentsController {
  constructor(@Inject(AccessService) private readonly access:AccessService,
    @Inject(PaymentsService) private readonly payments:PaymentsService,
    @Inject(RateLimitService) private readonly rate:RateLimitService) {}

  @Get()
  async list(@Req() req:AuthenticatedRequest,@Param('orgId',ParseUUIDPipe) orgId:string,
    @Param('customerId',ParseUUIDPipe) customerId:string,@Param('bookingId',ParseUUIDPipe) bookingId:string) {
    return this.payments.list(await this.access.membership(req.user.id,orgId),customerId,bookingId);
  }

  @Post()
  @UseGuards(PaymentUploadGuard)
  @UseInterceptors(FilesInterceptor('receipts',MAX_RECEIPTS,{
    limits:{fileSize:MAX_RECEIPT_BYTES,files:MAX_RECEIPTS,fields:4,fieldSize:4096,parts:MAX_RECEIPTS+4,fieldNameSize:100},
    fileFilter:(_req,file,callback)=>{
      if(!['image/jpeg','image/png','image/webp'].includes(file.mimetype)) {
        callback(new BadRequestException('Receipts must be JPEG, PNG, or WebP images.'),false);
      } else callback(null,true);
    },
  }))
  async submit(@Req() req:AuthenticatedRequest,@Param('orgId',ParseUUIDPipe) orgId:string,
    @Param('customerId',ParseUUIDPipe) customerId:string,@Param('bookingId',ParseUUIDPipe) bookingId:string,
    @Body() body:unknown,@UploadedFiles() files:PaymentUpload[]) {
    return this.payments.submit(await this.access.membership(req.user.id,orgId),customerId,bookingId,body,files);
  }

  @Post(':paymentId/approve')
  async approve(@Req() req:AuthenticatedRequest,@Param('orgId',ParseUUIDPipe) orgId:string,
    @Param('customerId',ParseUUIDPipe) customerId:string,@Param('bookingId',ParseUUIDPipe) bookingId:string,
    @Param('paymentId',ParseUUIDPipe) paymentId:string,@Body() body:unknown) {
    const member=await this.access.membership(req.user.id,orgId,true);
    await this.rate.consume('payment-review',req.user.id,120,3600);
    return this.payments.approve(member,customerId,bookingId,paymentId,body);
  }

  @Post(':paymentId/reject')
  async reject(@Req() req:AuthenticatedRequest,@Param('orgId',ParseUUIDPipe) orgId:string,
    @Param('customerId',ParseUUIDPipe) customerId:string,@Param('bookingId',ParseUUIDPipe) bookingId:string,
    @Param('paymentId',ParseUUIDPipe) paymentId:string,@Body() body:unknown) {
    const member=await this.access.membership(req.user.id,orgId,true);
    await this.rate.consume('payment-review',req.user.id,120,3600);
    return this.payments.reject(member,customerId,bookingId,paymentId,body);
  }

  @Get(':paymentId/receipts/:receiptId')
  async receipt(@Req() req:AuthenticatedRequest,@Param('orgId',ParseUUIDPipe) orgId:string,
    @Param('customerId',ParseUUIDPipe) customerId:string,@Param('bookingId',ParseUUIDPipe) bookingId:string,
    @Param('paymentId',ParseUUIDPipe) paymentId:string,@Param('receiptId',ParseUUIDPipe) receiptId:string,
    @Query('download') download:string|undefined,@Res() res:Response) {
    if(download!==undefined && download!=='1') throw new BadRequestException('Unsupported receipt download option.');
    const receipt=await this.payments.receipt(await this.access.membership(req.user.id,orgId),customerId,bookingId,paymentId,receiptId);
    const fallback=receipt.name.replace(/[^A-Za-z0-9 ._()-]/g,'_');
    const encoded=encodeURIComponent(receipt.name).replace(/[!'()*]/g,char=>`%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    res.setHeader('Content-Type',receipt.mime_type);
    res.setHeader('Content-Length',receipt.size);
    res.setHeader('Content-Disposition',`${download==='1'?'attachment':'inline'}; filename="${fallback}"; filename*=UTF-8''${encoded}`);
    res.setHeader('Cache-Control','private, no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.send(receipt.content);
  }
}

@Controller('organizations/:orgId/payment-submissions')
@UseGuards(SessionGuard)
export class PaymentReviewController {
  constructor(@Inject(AccessService) private readonly access:AccessService,@Inject(PaymentsService) private readonly payments:PaymentsService) {}
  @Get()
  async list(@Req() req:AuthenticatedRequest,@Param('orgId',ParseUUIDPipe) orgId:string,@Query() query:Record<string,unknown>) {
    return this.payments.reviewQueue(await this.access.membership(req.user.id,orgId,true),query);
  }
}
