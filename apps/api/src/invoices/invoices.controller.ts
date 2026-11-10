import { Controller, Get, Inject, Param, ParseUUIDPipe, Query, Req, Res, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AccessService } from '../access/access.service';
import { SessionGuard } from '../auth/session.guard';
import { DocumentDownloadInterceptor } from '../bookings/document-download.interceptor';
import { InvoicesService } from './invoices.service';

type AuthRequest = Request & { user: { id: string } };

@Controller('organizations/:orgId/customers/:customerId/bookings/:bookingId/invoices')
@UseGuards(SessionGuard)
export class InvoicesController {
  constructor(@Inject(AccessService) private readonly access: AccessService, @Inject(InvoicesService) private readonly invoices: InvoicesService) {}

  @Get()
  async list(@Req() req: AuthRequest, @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('customerId', ParseUUIDPipe) customerId: string, @Param('bookingId', ParseUUIDPipe) bookingId: string, @Query() query: unknown) {
    return this.invoices.list(await this.access.membership(req.user.id, orgId), customerId, bookingId, query);
  }

  @Get(':invoiceId/pdf')
  @UseInterceptors(DocumentDownloadInterceptor)
  async pdf(@Req() req: AuthRequest, @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('customerId', ParseUUIDPipe) customerId: string, @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string, @Res() res: Response) {
    const invoice = await this.invoices.pdf(await this.access.membership(req.user.id, orgId), customerId, bookingId, invoiceId);
    res.set({
      'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${invoice.filename}"`,
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    });
    res.send(invoice.content);
  }
}
