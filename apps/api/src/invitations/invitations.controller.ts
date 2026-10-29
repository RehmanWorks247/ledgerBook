import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuthService } from '../auth/auth.service';
import { parseBody } from '../auth/auth.controller';
import { RateLimitService } from '../auth/rate-limit.service';
import { sessionToken, setSessionCookie } from '../auth/session.guard';
import { InvitationService } from './invitation.service';

const inspectSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'This invitation link is invalid. Ask your administrator for a new invitation.') }).strict();
const acceptSchema = inspectSchema.extend({ password: z.string().min(12, 'Use at least 12 characters for your password.').max(128).optional() });

@Controller('auth/invitations')
export class InvitationsController {
  constructor(
    @Inject(InvitationService) private readonly invitations: InvitationService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(RateLimitService) private readonly rates: RateLimitService,
  ) {}

  @Post('inspect')
  @HttpCode(200)
  async inspect(@Body() input: unknown, @Req() request: Request) {
    await this.rates.consume('invitation-inspect', request.ip ?? '', 60, 900);
    const body = parseBody(inspectSchema, input);
    return this.invitations.inspect(body.token);
  }

  @Post('accept')
  @HttpCode(200)
  async accept(@Body() input: unknown, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.rates.consume('invitation-accept', request.ip ?? '', 20, 900);
    const body = parseBody(acceptSchema, input);
    await this.rates.consume('invitation-token', body.token, 10, 900);
    const user = await this.auth.authenticate(sessionToken(request));
    const result = await this.invitations.accept(body.token, user?.id, body.password);
    if (result.token) setSessionCookie(response, result.token);
    return { user: result.user, membershipId: result.membershipId };
  }
}
