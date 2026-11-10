import { Body, Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { RateLimitService } from '../auth/rate-limit.service';
import { type AuthenticatedRequest, SessionGuard } from '../auth/session.guard';
import { OrganizationsService } from './organizations.service';

@Controller('organizations')
@UseGuards(SessionGuard)
export class OrganizationsController {
  constructor(
    @Inject(OrganizationsService) private readonly organizations: OrganizationsService,
    @Inject(RateLimitService) private readonly rates: RateLimitService,
  ) {}

  @Post()
  async create(@Req() request: AuthenticatedRequest, @Body() input: unknown) {
    await this.rates.consume('workspace-create', request.user.id, 20, 3600);
    return this.organizations.create(request.user.id, input);
  }

  @Get(':orgId')
  async get(@Req() request: AuthenticatedRequest, @Param('orgId', ParseUUIDPipe) orgId: string) {
    await this.rates.consume('workspace-read', request.user.id, 240, 60);
    return this.organizations.get(request.user.id, orgId);
  }

  @Patch(':orgId')
  async update(@Req() request: AuthenticatedRequest, @Param('orgId', ParseUUIDPipe) orgId: string, @Body() input: unknown) {
    await this.rates.consume('workspace-update', request.user.id, 60, 60);
    return this.organizations.update(request.user.id, orgId, input);
  }

  @Delete(':orgId')
  async remove(@Req() request: AuthenticatedRequest, @Param('orgId', ParseUUIDPipe) orgId: string, @Body() input: unknown) {
    await this.rates.consume('workspace-delete', request.user.id, 20, 3600);
    return this.organizations.remove(request.user.id, orgId, input);
  }
}
