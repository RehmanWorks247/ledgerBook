import { Controller, Get, Inject, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AccessService } from '../access/access.service';
import { SessionGuard } from '../auth/session.guard';
import { PaymentEmailOutbox } from './email-outbox.service';

@Controller('organizations/:orgId/payment-email-status')
@UseGuards(SessionGuard)
export class PaymentEmailStatusController {
  constructor(@Inject(AccessService) private readonly access: AccessService,
    @Inject(PaymentEmailOutbox) private readonly outbox: PaymentEmailOutbox) {}

  @Get()
  async status(@Req() request: Request & {user:{id:string}}, @Param('orgId',ParseUUIDPipe) orgId: string) {
    return this.outbox.status(await this.access.membership(request.user.id,orgId,true));
  }
}
