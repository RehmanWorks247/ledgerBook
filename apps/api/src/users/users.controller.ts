import { Body, Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { AccessService } from '../access/access.service';
import { type AuthenticatedRequest, SessionGuard } from '../auth/session.guard';
import { RateLimitService } from '../auth/rate-limit.service';
import { z } from 'zod';
import { parseBody } from '../auth/auth.controller';
import { UsersService } from './users.service';

export const permanentDeletionSchema = z.object({ confirmation_email: z.string().trim().toLowerCase().email().max(254) }).strict();

@Controller('organizations/:orgId/users')
@UseGuards(SessionGuard)
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService, @Inject(AccessService) private readonly access: AccessService, @Inject(RateLimitService) private readonly rates: RateLimitService) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest, @Param('orgId',ParseUUIDPipe) orgId: string) {
    return this.users.list(await this.access.membership(request.user.id,orgId,true));
  }
  @Post(':id/disable')
  async disable(@Req() request: AuthenticatedRequest, @Param('orgId',ParseUUIDPipe) orgId: string, @Param('id',ParseUUIDPipe) id: string) { return this.change(request,orgId,id,'disable'); }
  @Post(':id/enable')
  async enable(@Req() request: AuthenticatedRequest, @Param('orgId',ParseUUIDPipe) orgId: string, @Param('id',ParseUUIDPipe) id: string) { return this.change(request,orgId,id,'enable'); }
  @Delete(':id')
  async remove(@Req() request: AuthenticatedRequest, @Param('orgId',ParseUUIDPipe) orgId: string, @Param('id',ParseUUIDPipe) id: string, @Body() input: unknown) {
    const body = parseBody(permanentDeletionSchema,input);
    return this.change(request,orgId,id,'delete',body.confirmation_email);
  }

  private async change(request: AuthenticatedRequest, orgId: string, id: string, action: 'disable' | 'enable' | 'delete', confirmationEmail?: string) {
    await this.rates.consume('user-management',request.user.id,60,3600);
    return this.users.update(await this.access.membership(request.user.id,orgId,true),id,action,confirmationEmail);
  }
}
