import { Global, Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { RateLimitService } from './rate-limit.service';
import { SessionGuard } from './session.guard';

@Global()
@Module({ imports: [NotificationsModule], controllers: [AuthController], providers: [AuthService, RateLimitService, SessionGuard], exports: [AuthService, RateLimitService, SessionGuard] })
export class AuthModule {}
