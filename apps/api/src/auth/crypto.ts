import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';

const PARAMETERS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };

export function opaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, PARAMETERS, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export function validatePassword(password: unknown, email?: string): asserts password is string {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    throw new BadRequestException('Use a password between 12 and 128 characters.');
  }
  const common = new Set(['password1234', 'password12345', 'password123456', '123456789012', 'qwerty12345678']);
  if (common.has(password.toLowerCase()) || (email && password.toLowerCase().includes(email.toLowerCase()))) {
    throw new BadRequestException('Choose a password that is difficult to guess and does not contain your email.');
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$32768$8$3$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt' || parts[1] !== '32768' || parts[2] !== '8' || parts[3] !== '3') return false;
  if (!/^[a-f0-9]{32}$/.test(parts[4]) || !/^[a-f0-9]{128}$/.test(parts[5])) return false;
  const actual = await derive(password, Buffer.from(parts[4], 'hex'));
  return timingSafeEqual(actual, Buffer.from(parts[5], 'hex'));
}

// Missing identities still incur the same expensive password derivation.
export const DUMMY_PASSWORD_HASH = 'scrypt$32768$8$3$00000000000000000000000000000000$' + '0'.repeat(128);
