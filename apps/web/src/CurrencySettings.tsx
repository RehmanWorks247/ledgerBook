import { useState, type FormEvent } from 'react';
import { useCurrency, type CurrencyQuote } from './currency';
import { useOrganization } from './state';
import { errorMessage } from './api';
import { ErrorNotice } from './components';

function RateEditor({ quote, base }: { quote: CurrencyQuote; base: string }) {
  const { override, busy } = useCurrency();
  const [value, setValue] = useState(quote.rate ?? '');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  async function save(event?: FormEvent, reset = false) {
    event?.preventDefault(); setError(''); setNotice('');
    try { await override(quote.code, reset ? null : value.trim()); setNotice(reset ? 'Automatic rate restored.' : 'Rate saved for everyone in this workspace.'); }
    catch (error) { setError(errorMessage(error)); }
  }
  return <form className="rate-editor" onSubmit={save}>
    <label><span>1 {base} =</span><input aria-label={`${quote.code} exchange rate`} inputMode="decimal" value={value}
      onChange={e => setValue(e.target.value)} required maxLength={22} pattern="[0-9]+([.][0-9]{1,12})?" /></label>
    <span>{quote.code}</span>
    <button className="button secondary small" disabled={busy}>Save rate</button>
    {quote.source === 'manual' && <button className="button ghost small" type="button" disabled={busy}
      onClick={() => { void save(undefined, true); }}>Use automatic</button>}
    <ErrorNotice message={error} /><span className="rate-save-status" role="status">{notice}</span>
  </form>;
}

export function CurrencySettingsPanel() {
  const { data, refresh } = useCurrency();
  const member = useOrganization();
  const [search, setSearch] = useState('');
  return <section className="panel currency-settings" aria-labelledby="currency-settings-title">
    <header><div><h2 id="currency-settings-title">Currencies & exchange rates</h2>
      <p>Travel ledgers display GBP. Reference rates convert historical balances from other accounting currencies.</p></div>
      <strong>GBP</strong></header>
    <p className="muted">Accounting currency: <strong>{member.currency}</strong>. Converted balances and exports use the current rate.
      Transactions stay recorded in {member.currency}; changing a rate updates their displayed value.</p>
    <div className="currency-rate-meta"><span>Daily reference rates from <a href="https://frankfurter.dev/" target="_blank" rel="noreferrer">Frankfurter</a>.
      {data?.fetched_at ? ` Last checked ${new Date(data.fetched_at).toLocaleString()}.` : ' Rates are loading or unavailable.'}
      {data?.unavailable ? ' The provider is unavailable; cached rates are shown where available.' : ''}</span>
      <button className="button secondary small" onClick={() => { void refresh(); }}>Check rates</button></div>
    <p className="muted">{member.role === 'admin' ? 'Manual rates apply to everyone in this workspace until you restore the automatic rate.' : 'An administrator can change workspace exchange rates.'}</p>
    <label className="currency-search">Find a currency<input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search code or name" /></label>
    <div className="currency-rate-list">
      {data?.currencies.filter(c => c.code !== data.base_currency && `${c.code} ${c.name}`.toLowerCase().includes(search.toLowerCase())).map(quote =>
        <div className="currency-rate-row" key={quote.code}><div><strong>{quote.code} <span>{quote.name}</span></strong>
          <small>{quote.available ? `${quote.source === 'manual' ? 'Manual' : 'Automatic'} · ${quote.date}${quote.stale ? ' · Stale' : ''}` : 'Rate unavailable'}</small></div>
          {member.role === 'admin' ? <RateEditor key={`${quote.code}:${quote.rate}:${quote.source}`} quote={quote} base={data.base_currency} />
            : <span>{quote.available ? `1 ${data.base_currency} = ${quote.rate} ${quote.code}` : '—'}</span>}
        </div>)}
    </div>
  </section>;
}
