import { Body, Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AccessService } from '../access/access.service';
import { SessionGuard } from '../auth/session.guard';
import { RateLimitService } from '../auth/rate-limit.service';
import { InvitationService } from '../invitations/invitation.service';
import { LedgerService } from '../ledger/ledger.service';
import { UsersService } from '../users/users.service';
import { permanentDeletionSchema } from '../users/users.controller';
import { parseBody } from '../auth/auth.controller';
import { CustomersService } from './customers.service';
import { CurrencyService } from '../currency/currency.service';
import { DashboardService } from '../dashboard/dashboard.service';

type AuthRequest=Request & {user:{id:string;email:string}};
@Controller('organizations/:orgId')
@UseGuards(SessionGuard)
export class CustomersController {
  constructor(@Inject(AccessService) private readonly access:AccessService,
    @Inject(CustomersService) private readonly customers:CustomersService,
    @Inject(LedgerService) private readonly ledger:LedgerService,
    @Inject(InvitationService) private readonly invitations:InvitationService,
    @Inject(RateLimitService) private readonly rate:RateLimitService,
    @Inject(CurrencyService) private readonly currencies:CurrencyService,
    @Inject(DashboardService) private readonly dashboardService:DashboardService,
    @Inject(UsersService) private readonly users:UsersService) {}

  @Get('dashboard')
  async dashboard(@Req() req:AuthRequest,@Param('orgId',ParseUUIDPipe) orgId:string,@Query() query:unknown) {
    return this.dashboardService.overview(await this.access.membership(req.user.id,orgId,true),query);
  }
  @Get('customer-ledger')
  async combinedLedger(@Req() req:AuthRequest,@Param('orgId',ParseUUIDPipe) orgId:string,@Query() query:unknown) {
    return this.dashboardService.combinedLedger(await this.access.membership(req.user.id,orgId,true),query);
  }
  @Get('customers')
  async list(@Req() req:AuthRequest,@Param('orgId',ParseUUIDPipe) orgId:string,@Query() query:unknown) {
    return this.customers.list(await this.access.membership(req.user.id,orgId,true),query);
  }
  @Post('customers')
  async create(@Req() req:AuthRequest,@Param('orgId',ParseUUIDPipe) orgId:string,@Body() body:unknown) {
    await this.rate.consume('customer-create',req.user.id,30,3600);
    return this.customers.create(await this.access.membership(req.user.id,orgId,true),body);
  }
  @Get('customers/:id')
  async get(@Req() req:AuthRequest,@Param('orgId',ParseUUIDPipe) orgId:string,@Param('id',ParseUUIDPipe) id:string) {
    return this.customers.get(await this.access.membership(req.user.id,orgId),id);
  }
  @Patch('customers/:id')
  async update(@Req() req:AuthRequest,@Param('orgId',ParseUUIDPipe) orgId:string,@Param('id',ParseUUIDPipe) id:string,@Body() body:unknown) {
    return this.customers.update(await this.access.membership(req.user.id,orgId,true),id,body);
  }
  @Delete('customers/:id')
  async remove(@Req() req:AuthRequest,@Param('orgId',ParseUUIDPipe) orgId:string,@Param('id',ParseUUIDPipe) id:string,@Body() input:unknown) {
    await this.rate.consume('account-delete',req.user.id,30,3600);
    const body=parseBody(permanentDeletionSchema,input);
    return this.users.deleteCustomer(await this.access.membership(req.user.id,orgId,true),id,body.confirmation_email);
  }
  @Post('customers/:id/invitations')
  async invite(@Req() req:AuthRequest,@Param('orgId',ParseUUIDPipe) orgId:string,@Param('id',ParseUUIDPipe) id:string) {
    await this.rate.consume('invite-actor',req.user.id,30,3600);
    await this.rate.consume('invite-account',`${orgId}:${id}`,5,3600);
    return this.invitations.invite(await this.access.membership(req.user.id,orgId,true),id);
  }
  @Delete('customers/:id/invitations')
  async revoke(@Req() req:AuthRequest,@Param('orgId',ParseUUIDPipe) orgId:string,@Param('id',ParseUUIDPipe) id:string) {
    await this.rate.consume('invite-revoke',req.user.id,60,3600);
    await this.invitations.revoke(await this.access.membership(req.user.id,orgId,true),id);
    return {message:'Invitation revoked.'};
  }
  @Post('customers/:id/revoke-access')
  async revokeAccess(@Req() req:AuthRequest,@Param('orgId',ParseUUIDPipe) orgId:string,@Param('id',ParseUUIDPipe) id:string) {
    await this.invitations.revokeAccess(await this.access.membership(req.user.id,orgId,true),id);
    return {message:'Customer access revoked. Ledger history is preserved.'};
  }
  @Post('customers/:id/entries')
  async post(@Req() req:AuthRequest,@Param('orgId',ParseUUIDPipe) orgId:string,@Param('id',ParseUUIDPipe) id:string,@Body() body:Parameters<LedgerService['post']>[2]) {
    await this.rate.consume('ledger-write',req.user.id,120,60);
    return this.ledger.post(await this.access.membership(req.user.id,orgId,true),id,body);
  }
  @Get('customers/:id/statement')
  async statement(@Req() req:AuthRequest,@Param('orgId',ParseUUIDPipe) orgId:string,@Param('id',ParseUUIDPipe) id:string,@Query() query:Parameters<LedgerService['statement']>[2]) {
    return this.ledger.statement(await this.access.membership(req.user.id,orgId),id,query);
  }
  @Get('customers/:id/statement.csv')
  async csv(@Req() req:AuthRequest,@Param('orgId',ParseUUIDPipe) orgId:string,@Param('id',ParseUUIDPipe) id:string,@Query() query:Parameters<LedgerService['csv']>[2] & {currency?:string},@Res() res:Response) {
    await this.rate.consume('statement-export',req.user.id,20,60);
    const member = await this.access.membership(req.user.id,orgId);
    await this.access.customer(member,id);
    const { currency, ...filters } = query ?? {};
    const csv=await this.ledger.csv(member,id,filters,await this.currencies.conversion(member,currency));
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',`attachment; filename="statement-${id}.csv"`);
    res.send(csv);
  }
}
