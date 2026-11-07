import { Global, Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { ClerkService } from './clerk.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { RateLimitService } from './rate-limit.service';
import { SessionGuard } from './session.guard';

@Global()
@Module({ imports: [NotificationsModule], controllers: [AuthController], providers: [AuthService, RateLimitService, SessionGuard, ClerkService], exports: [AuthService, RateLimitService, SessionGuard, ClerkService] })
export class AuthModule {}
