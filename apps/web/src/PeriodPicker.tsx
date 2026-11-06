import { useEffect, useRef, useState } from 'react';
import { CalendarDays, ChevronDown } from 'lucide-react';
import { dateLabel } from './api';

export type Period = { start: string; end: string };
export function presetPeriod(today: string, preset: 'month' | 'previous' | '30days'): Period {
  const day = new Date(`${today}T12:00:00Z`);
  const iso = (value: Date) => value.toISOString().slice(0, 10);
  if (preset === '30days') { day.setUTCDate(day.getUTCDate() - 29); return { start: iso(day), end: today }; }
  const year = day.getUTCFullYear(), month = day.getUTCMonth();
  return preset === 'previous'
    ? { start: iso(new Date(Date.UTC(year, month - 1, 1, 12))), end: iso(new Date(Date.UTC(year, month, 0, 12))) }
    : { start: iso(new Date(Date.UTC(year, month, 1, 12))), end: iso(new Date(Date.UTC(year, month + 1, 0, 12))) };
}
export function PeriodPicker({ today, value, onChange }: { today: string; value: Period; onChange: (value: Period) => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);
  function apply(period: Period) { onChange(period); setOpen(false); panel.current?.querySelector('button')?.focus(); }
  return <div ref={panel} className="period-picker"
    onKeyDown={event => { if (event.key === 'Escape') { setOpen(false); panel.current?.querySelector('button')?.focus(); } }}>
    <button type="button" className="period-trigger" aria-label="Reporting period" aria-expanded={open}
      onClick={() => { setError(''); setOpen(!open); }}><CalendarDays size={16} /><span>{dateLabel(value.start)} – {dateLabel(value.end)}</span><ChevronDown size={15} /></button>
    {open && <div className="period-popover"><div className="period-presets">{(['month', 'previous', '30days'] as const).map((preset, index) =>
      <button type="button" className="button secondary" key={preset} onClick={() => apply(presetPeriod(today, preset))}>{['This month', 'Last month', 'Last 30 days'][index]}</button>)}</div>
      <form onSubmit={event => {
        event.preventDefault();
        const fields = new FormData(event.currentTarget);
        const period = { start: String(fields.get('start') || ''), end: String(fields.get('end') || '') };
        if (!period.start || !period.end || period.start > period.end) { setError('From must be on or before To.'); return; }
        apply(period);
      }}>
        <div className="period-dates"><label>From<input name="start" aria-label="Reporting period from" required type="date" defaultValue={value.start} /></label>
          <label>To<input name="end" aria-label="Reporting period to" required type="date" defaultValue={value.end} /></label></div>
        {error && <p role="alert" className="notice error">{error}</p>}
        <button className="button">Apply</button>
      </form>
    </div>}
  </div>;
}
