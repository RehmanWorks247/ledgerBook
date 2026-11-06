import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { createClient } from 'redis';
import { DatabaseService } from '../database/database.service';
import { config } from '../config';
import { CURRENCIES, validRate } from './math';

export type Rate = { rate: string; date: string; source: 'Frankfurter' | 'manual' | 'identity'; stale: boolean };
type Snapshot = { base: string; fetched_at: string; rates: Record<string, Rate> };
export type RateSnapshot = { rates: Record<string, Rate>; fetched_at: string | null; unavailable: boolean };

@Injectable()
export class RatesService implements OnApplicationShutdown {
  private redis?: ReturnType<typeof createClient>;
  private connecting?: Promise<unknown>;
  private retryRedisAt = 0;
  private pending = new Map<string, Promise<RateSnapshot>>();
  private retryAt = new Map<string, number>();
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  private async cache() {
    if (!config.redisUrl || Date.now() < this.retryRedisAt) return undefined;
    if (!this.redis) {
      this.redis = createClient({ url: config.redisUrl, disableOfflineQueue: true, commandOptions: { timeout: 1000 },
        socket: { connectTimeout: 1000, socketTimeout: 5000, reconnectStrategy: false } });
      this.redis.on('error', () => { /* The durable cache remains available. */ });
    }
    if (this.redis.isReady) return this.redis;
    try {
      this.connecting ??= this.redis.connect();
      await this.connecting;
      return this.redis;
    } catch { this.retryRedisAt = Date.now() + 60_000; return undefined; }
    finally { this.connecting = undefined; }
  }

  async get(base: string): Promise<RateSnapshot> {
    const existing = this.pending.get(base);
    if (existing) return existing;
    const task = this.load(base).finally(() => this.pending.delete(base));
    this.pending.set(base, task);
    return task;
  }

  private parse(value: unknown, base: string): Snapshot | undefined {
    try {
      const data = (typeof value === 'string' ? JSON.parse(value) : value) as Snapshot;
      if (!data || data.base !== base || !Number.isFinite(Date.parse(data.fetched_at)) || !data.rates ||
        Object.values(data.rates).some(r => !validRate(r.rate) || !/^\d{4}-\d{2}-\d{2}$/.test(r.date))) return undefined;
      return data;
    } catch { return undefined; }
  }

  private async load(base: string): Promise<RateSnapshot> {
    const key = `ledgerbook:fx:v1:${base}`;
    const redis = await this.cache();
    let snapshot: Snapshot | undefined;
    try { snapshot = this.parse(await redis?.get(key), base); } catch { /* Use durable cache. */ }
    if (!snapshot) {
      const saved = await this.db.query('SELECT snapshot FROM exchange_rate_cache WHERE base_currency=$1', [base]);
      snapshot = this.parse(saved.rows[0]?.snapshot, base);
    }
    const now = Date.now();
    const expired = !snapshot || now - Date.parse(snapshot.fetched_at) >= config.exchangeRateTtlSeconds * 1000;
    let unavailable = false;
    if (expired && now >= (this.retryAt.get(base) ?? 0)) {
      try {
        const url = new URL(config.exchangeRateUrl);
        url.searchParams.set('base', base);
        url.searchParams.set('quotes', CURRENCIES.join(','));
        const response = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error('Rate provider unavailable');
        const rows: unknown = await response.json();
        if (!Array.isArray(rows) || !rows.length) throw new Error('Invalid rate response');
        const rates: Record<string, Rate> = {};
        for (const row of rows) {
          if (row.base !== base || !CURRENCIES.includes(row.quote) || typeof row.rate !== 'number' ||
            !Number.isFinite(row.rate) || row.rate <= 0 || row.rate > 100_000_000 ||
            typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
            !Number.isFinite(Date.parse(row.date)) || Date.parse(row.date) > now + 86400000) throw new Error('Invalid rate response');
          const rate = row.rate.toFixed(12).replace(/\.?0+$/, '');
          if (!validRate(rate)) throw new Error('Unsupported rate');
          rates[row.quote] = { rate, date: row.date, source: 'Frankfurter', stale: false };
        }
        snapshot = { base, fetched_at: new Date(now).toISOString(), rates };
        await this.db.query(`INSERT INTO exchange_rate_cache(base_currency,snapshot) VALUES($1,$2::jsonb)
          ON CONFLICT(base_currency) DO UPDATE SET snapshot=EXCLUDED.snapshot`, [base, JSON.stringify(snapshot)]);
        try { await redis?.set(key, JSON.stringify(snapshot), { EX: config.exchangeRateMaxAgeSeconds }); } catch { /* Durable cache is saved. */ }
        this.retryAt.delete(base);
      } catch { unavailable = true; this.retryAt.set(base, now + 60_000); }
    } else if (expired) unavailable = true;
    const rates: Record<string, Rate> = {};
    if (snapshot && now - Date.parse(snapshot.fetched_at) <= config.exchangeRateMaxAgeSeconds * 1000) {
      for (const [code, rate] of Object.entries(snapshot.rates)) {
        const age = now - Date.parse(rate.date);
        if (age <= config.exchangeRateMaxAgeSeconds * 1000) rates[code] = { ...rate,
          stale: unavailable || age > 3 * 86400000 };
      }
    }
    rates[base] = { rate: '1', date: new Date(now).toISOString().slice(0, 10), source: 'identity', stale: false };
    return { rates, fetched_at: snapshot?.fetched_at ?? null, unavailable };
  }

  async onApplicationShutdown() { if (this.redis?.isOpen) this.redis.destroy(); }
}
