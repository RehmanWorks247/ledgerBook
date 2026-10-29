import { Module } from '@nestjs/common';
import { AccessService } from '../access/access.service';
import { AuthModule } from '../auth/auth.module';
import { InvitationService } from './invitation.service';
import { InvitationsController } from './invitations.controller';

@Module({ imports: [AuthModule], controllers: [InvitationsController], providers: [AccessService, InvitationService], exports: [InvitationService] })
export class InvitationsModule {}
