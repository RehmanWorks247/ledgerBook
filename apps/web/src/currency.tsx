import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, errorMessage, money, mutate } from './api';
import { useOrganization } from './state';
import { convertMinor } from '../../api/src/currency/math';
import { ErrorNotice } from './components';
import { Link } from './router';

export type CurrencyQuote = { code: string; name: string; exponent: number; available: boolean;
  rate?: string; date?: string; source?: 'Frankfurter' | 'manual' | 'identity'; stale?: boolean };
export type CurrencySettings = { base_currency: string; base_exponent: number; display_currency: string;
  fetched_at: string | null; unavailable: boolean; currencies: CurrencyQuote[] };
type CurrencyState = { data?: CurrencySettings; error: string; busy: boolean; refresh: () => Promise<void>;
  select: (code: string) => Promise<void>; override: (code: string, rate: string | null) => Promise<void> };
export const CurrencyContext = createContext<CurrencyState>({ error: '', busy: false,
  refresh: async () => {}, select: async () => {}, override: async () => {} });
export const useCurrency = () => useContext(CurrencyContext);

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const member = useOrganization();
  const [data, setData] = useState<CurrencySettings>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const writing = useRef(false);
  const path = `/organizations/${member.organization_id}/currencies`;
  const refresh = useCallback(async () => {
    if (writing.current) return;
    const version = ++generation.current;
    try {
      const result = await api<CurrencySettings>(path);
      if (version === generation.current) { setData(result); setError(''); }
    } catch (error) { if (version === generation.current) setError(errorMessage(error)); }
  }, [path]);
  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 60_000);
    const focus = () => { void refresh(); };
    window.addEventListener('focus', focus);
    return () => { generation.current++; clearInterval(interval); window.removeEventListener('focus', focus); };
  }, [refresh]);
  async function update(suffix: string, body: unknown) {
    if (writing.current) return;
    writing.current = true;
    const version = ++generation.current;
    setBusy(true); setError('');
    try {
      const result = await mutate<CurrencySettings>(path + suffix, body, 'PATCH');
      if (version === generation.current) setData(result);
    } catch (error) {
      if (version === generation.current) setError(errorMessage(error));
      throw error;
    } finally { writing.current = false; setBusy(false); }
  }
  return <CurrencyContext.Provider value={{ data, error, busy, refresh,
    select: code => update('/preference', { currency: code }),
    override: (code, rate) => update(`/rates/${code}`, { rate }) }}>{children}</CurrencyContext.Provider>;
}

export function formatConvertedMoney(value: string | undefined, currency: string, exponent: number, data?: CurrencySettings) {
  if (!data || data.display_currency === currency || data.base_currency !== currency) return money(value, currency, exponent);
  const quote = data.currencies.find(c => c.code === data.display_currency);
  if (!quote?.available || !quote.rate) return `${data.display_currency} — rate unavailable`;
  return money(convertMinor(value || '0', exponent, quote.exponent, quote.rate), quote.code, quote.exponent);
}
export function useMoney() {
  const { data } = useCurrency();
  return (value: string | undefined, currency: string, exponent: number) => formatConvertedMoney(value, currency, exponent, data);
}

export function formatLedgerMoney(value: string | undefined, currency: string, exponent: number, data?: CurrencySettings) {
  if (currency === 'GBP') return money(value, 'GBP', 2);
  if (!data || data.base_currency !== currency) return 'GBP — rate unavailable';
  return formatConvertedMoney(value, currency, exponent, { ...data, display_currency: 'GBP' });
}
export function useLedgerMoney() {
  const { data } = useCurrency();
  return (value: string | undefined, currency: string, exponent: number) => formatLedgerMoney(value, currency, exponent, data);
}

export function LedgerCurrencyNotice() {
  const { data, error, refresh } = useCurrency();
  const member = useOrganization();
  if (member.currency === 'GBP') return null;
  const quote = data?.currencies.find(currency => currency.code === 'GBP');
  return <div className="currency-notice" role="status"><span>{quote?.available
    ? `GBP display · 1 ${member.currency} = ${quote.rate} GBP · ${quote.source === 'manual' ? 'Manual rate' : 'Reference rate'} · ${quote.date}${quote.stale ? ' · Stale rate' : ''}. Historical entries remain in ${member.currency}.`
    : `GBP conversion is ${error ? 'unavailable' : 'loading or unavailable'}. Historical entries remain in ${member.currency}.`}</span>
    <button className="text-link" onClick={() => { void refresh(); }}>Refresh rates</button></div>;
}

export function CurrencySelector({ id = 'display-currency' }: { id?: string }) {
  const { data, select, busy } = useCurrency();
  const member = useOrganization();
  return <label className="currency-selector" htmlFor={id}>
    <span>Currency</span>
    <select id={id} value={data?.display_currency ?? member.currency} disabled={!data || busy}
      onChange={event => { void select(event.target.value).catch(() => {}); }}>
      {!data && <option>{member.currency}</option>}
      {data?.currencies.map(c => <option key={c.code} value={c.code} disabled={!c.available}>
        {c.code}{!c.available ? ' · unavailable' : ''}
      </option>)}
    </select>
  </label>;
}

export function CurrencyNotice() {
  const { data, error, refresh } = useCurrency();
  const member = useOrganization();
  const quote = data?.currencies.find(c => c.code === data.display_currency);
  return <>
    <ErrorNotice message={error} />
    {error && <button className="button secondary small" onClick={() => { void refresh(); }}>Retry currency rates</button>}
    {data && data.display_currency !== data.base_currency && <div className="currency-notice" role="status">
      <span>{quote?.available
        ? `Viewing ${data.display_currency} · 1 ${data.base_currency} = ${quote.rate} ${data.display_currency} · ${quote.source === 'manual' ? 'Manual rate' : 'Reference rate'} · ${quote.date}${quote.stale ? ' · Stale rate' : ''}`
        : `The ${data.display_currency} rate is unavailable. Select another currency or set a manual rate.`}</span>
      <Link to={`/o/${member.organization_id}/settings`}>Manage rates</Link>
    </div>}
  </>;
}
