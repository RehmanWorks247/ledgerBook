import { Plus, X } from 'lucide-react';
import { dateLabel, money } from '../api';
import { bookingAmountInput } from './booking-model';
import type { BookingDraftFields } from './booking-draft';
import { parseInstalmentAmount } from './booking-instalments';
import { reminderSummary, type ReminderRow } from './booking-reminders';

type Props = {
  fields: BookingDraftFields;
  onChange: (patch: Partial<BookingDraftFields>) => void;
  today: string;
  recordedPaidMinor: string;
  creating: boolean;
};
const gbp = (minor: bigint) => money(minor.toString(), 'GBP', 2);

export function BookingInstalments({ fields, onChange, today, recordedPaidMinor, creating }: Props) {
  const rows = fields.instalments;
  const summary = reminderSummary(fields.amount, recordedPaidMinor, rows);
  function updateRows(next: ReminderRow[]) { onChange({ instalments: next, automaticReminder: undefined, remindersOnly: true }); }
  function addReminder() {
    updateRows([...rows, { key: crypto.randomUUID(), due_date: fields.effectiveDate || today,
      amount: summary.unplanned > 0n ? bookingAmountInput(summary.unplanned.toString()) : '' }]);
  }
  return <fieldset className="booking-instalments"><legend>Payment reminders</legend>
    <p className="booking-help">Choose when to follow up and how much to expect. Recorded payments reduce the earliest reminders automatically.</p>
    <div className="instalment-totals" role="region" aria-label="Payment totals" aria-live="polite">
      <div><span>Total</span><strong>{summary.bookingTotal === null ? '—' : gbp(summary.bookingTotal)}</strong></div>
      <div><span>Paid so far</span><strong>{gbp(summary.paid)}</strong></div>
      <div><span>Remaining</span><strong>{summary.remaining === null ? '—' : gbp(summary.remaining)}</strong></div>
    </div>
    {summary.credit > 0n && <p className="booking-help">Booking credit: {gbp(summary.credit)}.</p>}
    <div className="instalment-rows">{rows.map((row, index) => <div className="booking-instalment-row" role="group" aria-label={`Reminder ${index + 1}`} key={row.key}>
      <div className="instalment-row-heading"><strong>Reminder {index + 1}</strong></div>
      <label>Due date {index + 1}<input required type="date" value={row.due_date} onChange={event => updateRows(rows.map(item => item.key === row.key ? { ...item, due_date: event.target.value } : item))} /></label>
      <label>Amount (GBP)<input required inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" maxLength={20} value={row.amount} aria-invalid={row.amount !== '' && parseInstalmentAmount(row.amount) === null || undefined} onChange={event => updateRows(rows.map(item => item.key === row.key ? { ...item, amount: event.target.value } : item))} /></label>
      <button type="button" className="icon-button instalment-remove" aria-label={`Remove reminder ${index + 1}`} onClick={() => updateRows(rows.filter(item => item.key !== row.key))}><X size={17} /></button>
    </div>)}</div>
    {!rows.length && <p className="instalment-empty">{summary.remaining === 0n ? 'Fully paid. No reminders needed.' : 'No reminders set. You can add them whenever you need.'}</p>}
    <div className="instalment-actions"><button type="button" className="text-link" disabled={rows.length >= 100 || summary.remaining === 0n} onClick={addReminder}><Plus size={15} />Add reminder</button></div>
    <div id="reminder-validation" tabIndex={-1} role="status" className="reminder-status">
      {summary.over > 0n ? <p className="instalment-field-error">Reminders exceed the remaining balance by {gbp(summary.over)}. Reduce or remove an amount.</p>
        : !summary.incomplete && summary.unplanned > 0n ? <p className="booking-help">{gbp(summary.unplanned)} has no reminder yet.</p> : null}
      {summary.next && <p className="booking-help">Next reminder: {gbp(parseInstalmentAmount(summary.next.amount)!)} on {dateLabel(summary.next.due_date)}.</p>}
    </div>
    {creating && <p className="booking-help">Already received money? Create the booking, then record or link it in Payment history. Your balance and reminders will update.</p>}
  </fieldset>;
}
