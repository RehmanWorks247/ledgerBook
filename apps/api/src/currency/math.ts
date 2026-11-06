// Shared by the browser and server. All monetary arithmetic uses integers.
export const CURRENCIES = [
  'USD', 'PKR', 'EUR', 'GBP', 'AED', 'SAR', 'INR', 'CAD', 'AUD', 'NZD',
  'CHF', 'CNY', 'JPY', 'KRW', 'SGD', 'HKD', 'BDT', 'LKR', 'NPR', 'MYR',
  'THB', 'TRY', 'ZAR', 'KWD', 'BHD', 'OMR', 'QAR', 'SEK', 'NOK', 'DKK',
] as const;
export function currencyExponent(code: string): number {
  // ISO accounting precision, independent of changing CLDR cash-display defaults.
  if (['JPY', 'KRW'].includes(code)) return 0;
  if (['KWD', 'BHD', 'OMR'].includes(code)) return 3;
  return 2;
}
export function validRate(rate: unknown): rate is string {
  return typeof rate === 'string' && /^(?:0|[1-9]\d{0,8})(?:\.\d{1,12})?$/.test(rate)
    && Number(rate) > 0 && Number(rate) <= 100_000_000;
}
/** Round once, half away from zero, including zero- and three-decimal currencies. */
export function convertMinor(value: string | bigint, fromExponent: number, toExponent: number, rate: string, inverse = false): string {
  if (!validRate(rate)) throw new Error('A positive decimal exchange rate is required.');
  const [whole, fraction = ''] = rate.split('.');
  const numerator = BigInt(whole + fraction);
  const denominator = 10n ** BigInt(fraction.length);
  const amount = BigInt(value);
  const absolute = amount < 0n ? -amount : amount;
  const top = absolute * (inverse ? denominator : numerator) * 10n ** BigInt(toExponent);
  const bottom = (inverse ? numerator : denominator) * 10n ** BigInt(fromExponent);
  const rounded = (top + bottom / 2n) / bottom;
  return ((amount < 0n ? -1n : 1n) * rounded).toString();
}
