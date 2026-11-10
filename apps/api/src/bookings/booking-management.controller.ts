import { Body, Controller, Delete, Inject, Param, ParseUUIDPipe, Patch, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AccessService } from '../access/access.service';
import { SessionGuard } from '../auth/session.guard';
import { RateLimitService } from '../auth/rate-limit.service';
import { BookingManagementService } from './booking-management.service';

type AuthRequest=Request & {user:{id:string}};
@Controller('organizations/:orgId/customers/:customerId/bookings')
@UseGuards(SessionGuard)
export class BookingManagementController {
  constructor(@Inject(AccessService) private readonly access:AccessService,@Inject(BookingManagementService) private readonly bookings:BookingManagementService,
    @Inject(RateLimitService) private readonly rate:RateLimitService) {}

  @Patch(':bookingId')
  async update(@Req() req:AuthRequest,@Param('orgId',ParseUUIDPipe) orgId:string,@Param('customerId',ParseUUIDPipe) customerId:string,@Param('bookingId',ParseUUIDPipe) bookingId:string,@Body() body:unknown) {
    await this.rate.consume('booking-manage',req.user.id,120,3600);
    return this.bookings.update(await this.access.membership(req.user.id,orgId,true),customerId,bookingId,body);
  }

  @Delete(':bookingId')
  async cancel(@Req() req:AuthRequest,@Param('orgId',ParseUUIDPipe) orgId:string,@Param('customerId',ParseUUIDPipe) customerId:string,@Param('bookingId',ParseUUIDPipe) bookingId:string,@Body() body:unknown) {
    await this.rate.consume('booking-manage',req.user.id,120,3600);
    return this.bookings.cancel(await this.access.membership(req.user.id,orgId,true),customerId,bookingId,body);
  }
}
