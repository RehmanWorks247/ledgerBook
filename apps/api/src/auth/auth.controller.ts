import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuthService } from './auth.service';
import { RateLimitService } from './rate-limit.service';
import { type AuthenticatedRequest, clearSessionCookie, SessionGuard, sessionToken, setSessionCookie } from './session.guard';

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(128) }).strict();
const recoverySchema = z.object({ email: emailSchema }).strict();
const resetSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'This password reset link is invalid. Request a new link.'),
  password: z.string().min(12, 'Use at least 12 characters for your password.').max(128),
}).strict();

export function parseBody<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((issue) => issue.message).join(' '));
  return parsed.data;
}

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(RateLimitService) private readonly rates: RateLimitService) {}

  @Get('session')
  @UseGuards(SessionGuard)
  async session(@Req() request: AuthenticatedRequest) {
    await this.rates.consume('session-user', request.user.id, 120, 60);
    return this.auth.session(request.user);
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() input: unknown, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.rates.consume('login-ip', request.ip ?? '', 30, 900);
    const body = parseBody(loginSchema, input);
    await this.rates.consume('login-email', body.email, 10, 900);
    const result = await this.auth.login(body.email, body.password);
    await this.auth.logout(sessionToken(request));
    setSessionCookie(response, result.token);
    response.setHeader('Cache-Control', 'no-store');
    return { user: result.user };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.rates.consume('logout-ip', request.ip ?? '', 120, 900);
    await this.auth.logout(sessionToken(request));
    clearSessionCookie(response);
    return { ok: true };
  }

  @Post('forgot-password')
  @HttpCode(200)
  async forgotPassword(@Body() input: unknown, @Req() request: Request) {
    await this.rates.consume('recovery-ip', request.ip ?? '', 20, 3600);
    const body = parseBody(recoverySchema, input);
    await this.rates.consume('recovery-email', body.email, 5, 3600);
    return this.auth.forgotPassword(body.email);
  }

  @Post('reset-password')
  @HttpCode(200)
  async resetPassword(@Body() input: unknown, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.rates.consume('reset-ip', request.ip ?? '', 20, 900);
    const body = parseBody(resetSchema, input);
    await this.auth.resetPassword(body.token, body.password);
    clearSessionCookie(response);
    return { ok: true };
  }
}
