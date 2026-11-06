import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import { api, errorMessage, type Customer } from './api';
import { useOrganization } from './state';

export function CustomerPicker({ onSelect, activeOnly = true }: {
  onSelect: (customer: Customer | null) => void; activeOnly?: boolean;
}) {
  const member = useOrganization();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<Customer | null>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Customer[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [highlight, setHighlight] = useState(-1);
  const [retry, setRetry] = useState(0);
  const query = selected ? '' : text.trim();
  useEffect(() => {
    if (open && highlight >= 0) document.getElementById(`${id}-${highlight}`)?.scrollIntoView({ block: 'nearest' });
  }, [highlight, id, open]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true); setItems([]); setHighlight(-1); setError('');
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ search: query, status: activeOnly ? 'active' : 'all', page_size: '20' });
      api<{ items: Customer[]; total: number }>(`/organizations/${member.organization_id}/customers?${params}`, { signal: controller.signal })
        .then(result => { if (!controller.signal.aborted) { setItems(result.items); setTotal(result.total); } })
        .catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, open, activeOnly, member.organization_id, retry]);
  function choose(customer: Customer) {
    setSelected(customer); setText([customer.customer_code, customer.name].filter(Boolean).join(' · '));
    setOpen(false); setHighlight(-1); onSelect(customer);
  }
  return <div className="customer-picker" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <div className="customer-picker-input"><Search size={17} aria-hidden="true" />
      <input ref={input} role="combobox" aria-label="Customer name or ID" aria-autocomplete="list"
        aria-expanded={open} aria-controls={`${id}-options`} aria-activedescendant={open && highlight >= 0 ? `${id}-${highlight}` : undefined}
        autoComplete="off" placeholder="Customer name or ID" maxLength={160} value={text}
        onFocus={() => setOpen(true)} onChange={event => {
          setText(event.target.value); setSelected(null); onSelect(null); setItems([]); setLoading(true); setHighlight(-1); setOpen(true);
        }} onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); setOpen(true);
            if (items.length) setHighlight(previous => event.key === 'ArrowDown' ? Math.min(previous + 1, items.length - 1) : Math.max(previous - 1, 0));
          }
          if (event.key === 'Enter' && open) { event.preventDefault(); if (!loading && items[highlight]) choose(items[highlight]); }
        }} />
      <button type="button" className="icon-button" aria-label="Show customers" onClick={() => { input.current?.focus(); setOpen(true); }}><ChevronDown size={16} /></button>
    </div>
    {open && <div className="customer-picker-menu">
      <ul role="listbox" id={`${id}-options`} aria-label="Customers" aria-busy={loading}>
        {!loading && !error && items.map((customer, index) => <li key={customer.id} id={`${id}-${index}`} role="option"
          aria-selected={selected?.id === customer.id} className={index === highlight ? 'highlighted' : ''}
          onPointerDown={event => event.preventDefault()} onClick={() => choose(customer)} onPointerMove={() => setHighlight(index)}>
          <span className="customer-code">{customer.customer_code}</span><span>{customer.name}</span>
        </li>)}
      </ul>
      {loading ? <p role="status">Searching…</p> : error ? <div role="alert"><p>{error}</p><button type="button" className="text-link" onClick={() => setRetry(value => value + 1)}>Try again</button></div>
        : !items.length ? <p role="status">No matching customers</p> : total > items.length ? <p>Type to narrow {total} customers</p> : null}
    </div>}
  </div>;
}
