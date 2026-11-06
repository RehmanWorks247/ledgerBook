import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AccessService } from '../access/access.service';
import { SessionGuard } from '../auth/session.guard';
import { RateLimitService } from '../auth/rate-limit.service';
import { CurrencyService } from './currency.service';

@Controller('organizations/:orgId/currencies')
@UseGuards(SessionGuard)
export class CurrencyController {
  constructor(@Inject(AccessService) private readonly access: AccessService,
    @Inject(CurrencyService) private readonly currency: CurrencyService,
    @Inject(RateLimitService) private readonly limits: RateLimitService) {}
  @Get()
  async get(@Req() req: Request & { user: { id: string } }, @Param('orgId', ParseUUIDPipe) orgId: string) {
    return this.currency.settings(await this.access.membership(req.user.id, orgId));
  }
  @Patch('preference')
  async preference(@Req() req: Request & { user: { id: string } }, @Param('orgId', ParseUUIDPipe) orgId: string, @Body() body: unknown) {
    return this.currency.preference(await this.access.membership(req.user.id, orgId), body);
  }
  @Patch('rates/:currency')
  async rate(@Req() req: Request & { user: { id: string } }, @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('currency') currency: string, @Body() body: unknown) {
    const member = await this.access.membership(req.user.id, orgId, true);
    await this.limits.consume('currency-rate', req.user.id, 60, 60);
    return this.currency.override(member, currency, body);
  }
}
