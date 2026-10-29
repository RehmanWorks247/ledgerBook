import { BadRequestException } from '@nestjs/common';

export const MAX_AMOUNT_MINOR = 100_000_000_000_000n;

/** Parse decimal text without ever converting money through a JS Number. */
export function parseMoney(value: string, exponent: number, allowNegative = false): bigint {
  if (typeof value !== 'string' || ![0, 2, 3].includes(exponent)) {
    throw new BadRequestException('Enter an amount as decimal text.');
  }
  const text = value.trim();
  const pattern = allowNegative ? /^-?\d{1,18}(?:\.\d{1,3})?$/ : /^\d{1,18}(?:\.\d{1,3})?$/;
  if (!pattern.test(text)) throw new BadRequestException('Enter a valid decimal amount without commas or exponent notation.');
  const [whole, fraction = ''] = text.replace('-', '').split('.');
  if (fraction.length > exponent) throw new BadRequestException(`This currency allows ${exponent} decimal places.`);
  const magnitude = BigInt(whole) * 10n ** BigInt(exponent) + BigInt(fraction.padEnd(exponent, '0') || '0');
  if (magnitude === 0n || magnitude > MAX_AMOUNT_MINOR) throw new BadRequestException('The amount must be nonzero and within the supported limit.');
  return text.startsWith('-') ? -magnitude : magnitude;
}

export function formatMoney(minor: string | bigint, exponent: number): string {
  const amount = BigInt(minor);
  const absolute = amount < 0n ? -amount : amount;
  const scale = 10n ** BigInt(exponent);
  return `${amount < 0n ? '-' : ''}${absolute / scale}${exponent ? `.${(absolute % scale).toString().padStart(exponent, '0')}` : ''}`;
}

export function validDate(value: string): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '9999-12-31') return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
