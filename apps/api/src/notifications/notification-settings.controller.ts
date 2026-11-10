import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AccessService } from '../access/access.service';
import { SessionGuard } from '../auth/session.guard';
import { ReminderService } from './reminder.service';

type AuthenticatedRequest=Request&{user:{id:string}};
@Controller('organizations/:orgId/notifications')
@UseGuards(SessionGuard)
export class NotificationSettingsController {
  constructor(@Inject(AccessService) private readonly access:AccessService,@Inject(ReminderService) private readonly reminders:ReminderService) {}
  @Get('settings')
  async settings(@Req() request:AuthenticatedRequest,@Param('orgId',ParseUUIDPipe) orgId:string) {
    return this.reminders.settings(await this.access.membership(request.user.id,orgId,true));
  }
  @Patch('settings')
  async update(@Req() request:AuthenticatedRequest,@Param('orgId',ParseUUIDPipe) orgId:string,@Body() body:unknown) {
    return this.reminders.updateSettings(await this.access.membership(request.user.id,orgId,true),body);
  }
  @Get('history')
  async history(@Req() request:AuthenticatedRequest,@Param('orgId',ParseUUIDPipe) orgId:string) {
    return this.reminders.history(await this.access.membership(request.user.id,orgId,true));
  }
}

@Controller('organizations/:orgId/customers/:customerId/reminder-preferences')
@UseGuards(SessionGuard)
export class ReminderPreferencesController {
  constructor(@Inject(AccessService) private readonly access:AccessService,@Inject(ReminderService) private readonly reminders:ReminderService) {}
  @Get()
  async get(@Req() request:AuthenticatedRequest,@Param('orgId',ParseUUIDPipe) orgId:string,@Param('customerId',ParseUUIDPipe) customerId:string) {
    return this.reminders.preference(await this.access.membership(request.user.id,orgId),customerId);
  }
  @Patch()
  async update(@Req() request:AuthenticatedRequest,@Param('orgId',ParseUUIDPipe) orgId:string,@Param('customerId',ParseUUIDPipe) customerId:string,@Body() body:unknown) {
    return this.reminders.preference(await this.access.membership(request.user.id,orgId),customerId,body);
  }
}
