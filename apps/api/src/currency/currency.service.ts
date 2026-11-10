import { BadRequestException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import { AccessService, type Membership } from '../access/access.service';
import { DatabaseService } from '../database/database.service';
import { RatesService, type Rate } from './rates.service';
import { CURRENCIES, currencyExponent, validRate } from './math';

@Injectable()
export class CurrencyService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(RatesService) private readonly rates: RatesService) {}

  async settings(member: Membership) {
    const current = await this.access.membership(member.user_id, member.organization_id);
    const snapshot = await this.rates.get(current.currency!);
    // Concurrent workspaces share the provider request, never their overrides.
    const rates = { ...snapshot.rates };
    const overrides = await this.db.query('SELECT currency,rate::text,updated_at FROM exchange_rate_overrides WHERE organization_id=$1', [current.organization_id]);
    for (const row of overrides.rows) rates[row.currency] = {
      rate: row.rate.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''), date: new Date(row.updated_at).toISOString().slice(0,10), source: 'manual', stale: false,
    };
    const currencies = [...new Set<string>([current.currency!, ...CURRENCIES])].map(code => ({
      code, name: new Intl.DisplayNames(['en'], { type: 'currency' }).of(code) ?? code,
      exponent: code === current.currency ? current.currency_exponent! : currencyExponent(code),
      ...rates[code], available: Boolean(rates[code]),
    }));
    return { base_currency: current.currency!, base_exponent: current.currency_exponent!,
      display_currency: (current.display_currency as string | null) ?? current.currency!,
      fetched_at: snapshot.fetched_at, unavailable: snapshot.unavailable, currencies };
  }

  async preference(member: Membership, input: unknown) {
    const parsed = z.object({ currency: z.string().regex(/^[A-Z]{3}$/) }).strict().safeParse(input);
    if (!parsed.success) throw new BadRequestException('Choose a supported currency.');
    const settings = await this.settings(member);
    if (!settings.currencies.some(c => c.code === parsed.data.currency && c.available))
      throw new BadRequestException('A rate is not available for this currency.');
    await this.db.transaction(async client => {
      await this.access.membership(member.user_id, member.organization_id, false, client);
      await client.query('UPDATE memberships SET display_currency=$1 WHERE id=$2', [parsed.data.currency, member.id]);
    });
    return { ...settings, display_currency: parsed.data.currency };
  }

  async override(member: Membership, currency: string, input: unknown) {
    const parsed = z.object({ rate: z.union([z.string().refine(validRate), z.null()]) }).strict().safeParse(input);
    if (!parsed.success || !CURRENCIES.includes(currency as typeof CURRENCIES[number]) || currency === member.currency)
      throw new BadRequestException('Enter a positive rate with up to 12 decimal places for a supported foreign currency.');
    await this.db.transaction(async client => {
      await this.access.membership(member.user_id, member.organization_id, true, client);
      if (parsed.data.rate === null) await client.query('DELETE FROM exchange_rate_overrides WHERE organization_id=$1 AND currency=$2', [member.organization_id, currency]);
      else await client.query(`INSERT INTO exchange_rate_overrides(organization_id,currency,rate,updated_by) VALUES($1,$2,$3,$4)
        ON CONFLICT(organization_id,currency) DO UPDATE SET rate=EXCLUDED.rate,updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [member.organization_id, currency, parsed.data.rate, member.user_id]);
      await client.query(`INSERT INTO audit_events(organization_id,actor_id,action,object_id,metadata) VALUES($1,$2,$3,$4,$5::jsonb)`,
        [member.organization_id, member.user_id, 'currency.rate_updated', currency, JSON.stringify({ rate: parsed.data.rate })]);
    });
    return this.settings(member);
  }

  async conversion(member: Membership, code?: string): Promise<{ code: string; exponent: number; rate: Rate }> {
    if (code !== undefined && (typeof code !== 'string' || (code !== member.currency && !CURRENCIES.includes(code as typeof CURRENCIES[number]))))
      throw new BadRequestException('Choose a supported currency.');
    if (!code || code === member.currency) return { code: member.currency!, exponent: member.currency_exponent!,
      rate: { rate: '1', date: new Date().toISOString().slice(0,10), source: 'identity', stale: false } };
    const settings = await this.settings(member);
    const quote = settings.currencies.find(c => c.code === code);
    if (!quote?.available) throw new ServiceUnavailableException('An exchange rate is unavailable. Choose the accounting currency or set a manual rate in Settings.');
    return { code, exponent: quote.exponent, rate: { rate: quote.rate, date: quote.date, source: quote.source, stale: quote.stale } };
  }
}
