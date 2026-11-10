import { z } from 'zod';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
export const passwordSchema = z.string()
  .min(PASSWORD_MIN_LENGTH, 'Use at least 8 characters for your password.')
  .max(PASSWORD_MAX_LENGTH, 'Use no more than 128 characters for your password.');
