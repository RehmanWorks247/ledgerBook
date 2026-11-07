import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService, type AuthUser } from './auth.service';
import { config } from '../config';

export type AuthenticatedRequest = Request & { user: AuthUser };
export const SESSION_COOKIE = config.sessionCookie;

export function sessionToken(request: Request): string | undefined {
  if (config.authProvider === 'clerk') {
    const authorization = request.headers.authorization;
    return authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
  }
  const raw = request.headers.cookie;
  if (!raw) return undefined;
  return raw.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
}

export function setSessionCookie(response: Response, token: string): void {
  response.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.production,
    sameSite: 'lax',
    path: '/',
    maxAge: config.sessionTtlSeconds * 1000,
  });
}

export function clearSessionCookie(response: Response): void {
  response.clearCookie(SESSION_COOKIE, {
    httpOnly: true, secure: config.production, sameSite: 'lax', path: '/',
  });
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = await this.auth.authenticate(sessionToken(request));
    if (!user) throw new UnauthorizedException('Sign in to continue.');
    request.user = user;
    return true;
  }
}
