import { Body, Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { RateLimitService } from '../auth/rate-limit.service';
import { type AuthenticatedRequest, SessionGuard } from '../auth/session.guard';
import { CompaniesService } from './companies.service';

@Controller('organizations/:orgId/companies')
@UseGuards(SessionGuard)
export class CompaniesController {
  constructor(
    @Inject(CompaniesService) private readonly companies: CompaniesService,
    @Inject(RateLimitService) private readonly rates: RateLimitService,
  ) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest, @Param('orgId', ParseUUIDPipe) orgId: string, @Query() query: unknown) {
    await this.rates.consume('company-read', request.user.id, 240, 60);
    return this.companies.list(request.user.id, orgId, query);
  }

  @Post()
  async create(@Req() request: AuthenticatedRequest, @Param('orgId', ParseUUIDPipe) orgId: string, @Body() input: unknown) {
    await this.rates.consume('company-write', request.user.id, 240, 3600);
    return this.companies.create(request.user.id, orgId, input);
  }

  @Patch(':id')
  async update(@Req() request: AuthenticatedRequest, @Param('orgId', ParseUUIDPipe) orgId: string, @Param('id', ParseUUIDPipe) id: string, @Body() input: unknown) {
    await this.rates.consume('company-write', request.user.id, 240, 3600);
    return this.companies.update(request.user.id, orgId, id, input);
  }

  @Delete(':id')
  async remove(@Req() request: AuthenticatedRequest, @Param('orgId', ParseUUIDPipe) orgId: string, @Param('id', ParseUUIDPipe) id: string, @Body() input: unknown) {
    await this.rates.consume('company-write', request.user.id, 240, 3600);
    return this.companies.remove(request.user.id, orgId, id, input);
  }
}
