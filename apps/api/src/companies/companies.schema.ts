import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { MAX_AMOUNT_MINOR, validDate } from '../ledger/money';

const text = (max: number) => z.string().trim().max(max)
  .refine(value => !value.includes('\0'), 'Text cannot contain null characters.');
const date = z.string().refine(validDate, 'Use a valid date in YYYY-MM-DD format.');
const amount = z.string().trim().max(24).nullable();
const version = z.number().int().min(1).max(2147483646);

const fields = z.object({
  company_name: text(200).min(1, 'Enter a company name.'),
  hotel_name: text(200),
  customer_name: text(200),
  check_in: date.nullable(),
  check_out: date.nullable(),
  quantity: z.number().int().min(1).max(1000000),
  room_type: text(200),
  booking_date: date.nullable(),
  voucher_number: text(100),
  voucher_price: amount,
  remarks: text(2000),
});

export const createCompanySchema = fields.extend({
  hotel_name: fields.shape.hotel_name.default(''),
  customer_name: fields.shape.customer_name.default(''),
  check_in: fields.shape.check_in.default(null),
  check_out: fields.shape.check_out.default(null),
  quantity: fields.shape.quantity.default(1),
  room_type: fields.shape.room_type.default(''),
  booking_date: fields.shape.booking_date.default(null),
  voucher_number: fields.shape.voucher_number.default(''),
  voucher_price: amount.default(null),
  remarks: fields.shape.remarks.default(''),
  idempotency_key: z.uuid(),
}).strict();

export const updateCompanySchema = fields.partial().extend({ expected_version: version }).strict()
  .refine(value => Object.keys(value).some(key => key !== 'expected_version'), 'Provide at least one company field to update.');
export const deleteCompanySchema = z.object({ expected_version: version }).strict();
export const exportCompanySchema = z.object({ company_name: fields.shape.company_name }).strict();
export const updateCompanyPaidSchema = z.object({
  company_name: fields.shape.company_name,
  paid: z.string().trim().min(1).max(32),
  expected_version: z.number().int().min(0).max(2147483646),
}).strict();
const positiveQueryInteger = (max: number) => z.string().regex(/^\d+$/, 'Use a positive whole number.')
  .transform(Number).pipe(z.number().int().min(1).max(max));
export const listCompaniesSchema = z.object({
  company_name: text(200).min(1).optional(),
  search: text(200).default(''),
  date_field: z.enum(['booking_date', 'check_in', 'check_out']).default('booking_date'),
  start: date.optional(),
  end: date.optional(),
  page: positiveQueryInteger(1_000_000).default(1),
  page_size: positiveQueryInteger(100).default(25),
}).strict().refine(value => !value.start || !value.end || value.start <= value.end, 'The start date must be on or before the end date.');

export type CompanyInput = z.infer<typeof fields>;
export const companyFields = Object.keys(fields.shape) as (keyof CompanyInput)[];
export const moneyFields = ['voucher_price'] as const;

/** Parse a voucher price using exact currency minor units. */
export function companyAmount(value: string | null, exponent: number, signed = false): string | null {
  if (value === null) return null;
  const pattern = signed ? /^-?\d{1,18}(?:\.\d{1,3})?$/ : /^\d{1,18}(?:\.\d{1,3})?$/;
  if (!pattern.test(value) || ![0, 2, 3].includes(exponent)) {
    throw new BadRequestException('Enter a valid decimal amount without commas or exponent notation.');
  }
  const [whole, fraction = ''] = value.replace('-', '').split('.');
  if (fraction.length > exponent) throw new BadRequestException(`This currency allows ${exponent} decimal places.`);
  const magnitude = BigInt(whole) * 10n ** BigInt(exponent) + BigInt(fraction.padEnd(exponent, '0') || '0');
  if (magnitude > MAX_AMOUNT_MINOR) throw new BadRequestException('The amount exceeds the supported limit.');
  return (value.startsWith('-') ? -magnitude : magnitude).toString();
}

export function companyPaidAmount(value: string, exponent: number): string {
  if (!/^\d{1,27}(?:\.\d{1,3})?$/.test(value) || ![0, 2, 3].includes(exponent))
    throw new BadRequestException('Enter a nonnegative paid amount without commas or exponent notation.');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > exponent) throw new BadRequestException(`This currency allows ${exponent} decimal places.`);
  const minor = BigInt(whole) * 10n ** BigInt(exponent) + BigInt(fraction.padEnd(exponent, '0') || '0');
  return minor.toString();
}

export function validateStay(checkIn: string | null, checkOut: string | null): void {
  if (checkIn && checkOut && checkOut < checkIn) throw new BadRequestException('Check-out must be on or after check-in.');
}
