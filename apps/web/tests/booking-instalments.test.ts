import assert from 'node:assert/strict';
import { test } from 'node:test';
import { instalmentSummary, parseInstalmentAmount, splitInstalments, type InstalmentRow } from '../src/pages/booking-instalments';

const rows = (...amounts: string[]): InstalmentRow[] => amounts.map((amount, index) => ({
  key: `row-${index}`, due_date: `2026-12-${String(index + 1).padStart(2, '0')}`, amount,
}));

test('GBP calculations accept positive amounts within the API limit and reject partial or invalid values', () => {
  for (const [value, expected] of [['0.01', 1n], ['1', 100n], ['12.3', 1230n], [' 12.30 ', 1230n], ['1000000000000.00', 100_000_000_000_000n]] as const)
    assert.equal(parseInstalmentAmount(value), expected);
  for (const value of ['', ' ', '0', '0.00', '-1', '1.', '.50', '1.001', '5,000', '1e2', 'Infinity', '1000000000000.01', '0000000000000000001'])
    assert.equal(parseInstalmentAmount(value), null, value);
});

test('five total instalments divide £5,000 after the first £1,500 into four £875 payments', () => {
  assert.deepEqual(splitInstalments('5000', rows('1500', '', '', '', ''), 1), {
    amounts: ['875.00', '875.00', '875.00', '875.00'], remaining: 350000n, error: null,
  });
});

test('editing the second amount preserves the prefix and assigns any rounding pennies to the final instalment', () => {
  const input = rows('1500', '1000', '875', '875', '875');
  const before = structuredClone(input);
  const split = splitInstalments('5000', input, 2);
  assert.deepEqual(split, { amounts: ['833.33', '833.33', '833.34'], remaining: 250000n, error: null });
  assert.deepEqual(input, before, 'Calculations must not mutate amounts, dates or row keys.');
  assert.equal(split.amounts!.reduce((sum, amount) => sum + parseInstalmentAmount(amount)!, 0n), 250000n);
});

test('balancing preserves paid amounts and their metadata even when paid rows follow unpaid ones', () => {
  const input = rows('1500', '', '1000', '', '500');
  input[0] = { ...input[0], paid: true, paid_date: '2026-11-01', id: 'first', payment_entry_id: 'payment-first' };
  input[2] = { ...input[2], paid: true, paid_date: '2026-11-02', id: 'third', payment_entry_id: 'payment-third' };
  input[4].paid = true;
  const before = structuredClone(input);
  assert.deepEqual(splitInstalments('5000.01', input, 1), {
    amounts: ['1000.00', '1000', '1000.01', '500'], remaining: 200001n, error: null,
  });
  assert.deepEqual(splitInstalments('5000.01', input, 0), {
    amounts: ['1500', '1000.00', '1000', '1000.01', '500'], remaining: 200001n, error: null,
  });
  assert.deepEqual(input, before, 'Paid flags, dates, persisted IDs and all row values remain untouched.');
});

test('paid suffix amounts must be valid, and no suggestion is made when every later instalment is paid', () => {
  const input = rows('50', '50');
  input[1].paid = true;
  assert.deepEqual(splitInstalments('100', input, 1), {
    amounts: null, remaining: 0n, error: 'All later instalments are paid. Add an unpaid instalment to split the remaining amount into.',
  });
  input.push({ key: 'unpaid', due_date: '2026-12-03', amount: '' });
  for (const amount of ['', '12.', '0', '-10']) {
    input[1].amount = amount;
    const split = splitInstalments('100', input, 1);
    assert.equal(split.amounts, null);
    assert.equal(split.remaining, null);
    assert.match(split.error!, /paid instalment 2/);
  }
  input[1].amount = '60';
  const excess = splitInstalments('100', input, 1);
  assert.equal(excess.amounts, null);
  assert.equal(excess.remaining, -1000n);
});

test('splits can replace the whole schedule or only its final row and remain exact at the maximum total', () => {
  assert.deepEqual(splitInstalments('100', rows('', '', ''), 0).amounts, ['33.33', '33.33', '33.34']);
  assert.deepEqual(splitInstalments('100', rows('33.33', '33.33', ''), 2).amounts, ['33.34']);
  const split = splitInstalments('1000000000000', rows('', '', ''), 0);
  assert.deepEqual(split.amounts, ['333333333333.33', '333333333333.33', '333333333333.34']);
  assert.equal(split.amounts!.reduce((sum, amount) => sum + parseInstalmentAmount(amount)!, 0n), 100_000_000_000_000n);
});

test('invalid totals and earlier amounts withhold suggestions without changing input', () => {
  for (const total of ['', '5000.', '0', '-5']) {
    const split = splitInstalments(total, rows('1500', ''), 1);
    assert.equal(split.amounts, null);
    assert.equal(split.remaining, null);
    assert.match(split.error!, /valid instalment total/);
  }
  for (const amount of ['', '12.', '0', '-10']) {
    const input = rows(amount, '1000', '');
    const before = structuredClone(input);
    const split = splitInstalments('5000', input, 2);
    assert.equal(split.amounts, null);
    assert.equal(split.remaining, null);
    assert.match(split.error!, /instalment 1/);
    assert.deepEqual(input, before);
  }
});

test('oversubscribed schedules and too few remaining pennies never produce zero or negative instalments', () => {
  for (const [total, input, remaining] of [
    ['100', rows('101', ''), -100n],
    ['100', rows('100', ''), 0n],
    ['100', rows('99.99', '', ''), 1n],
  ] as const) {
    const split = splitInstalments(total, input, 1);
    assert.equal(split.amounts, null);
    assert.equal(split.remaining, remaining);
    assert.ok(split.error);
  }
  assert.deepEqual(splitInstalments('0.03', rows('', '', ''), 0).amounts, ['0.01', '0.01', '0.01']);
});

test('invalid suffix positions do not produce suggestions', () => {
  for (const start of [-1, 1, 0.5, NaN, Infinity]) {
    const split = splitInstalments('100', rows('100'), start);
    assert.equal(split.amounts, null);
    assert.ok(split.error);
  }
  assert.equal(splitInstalments('100', [], 0).amounts, null);
});

test('summary distinguishes complete, incomplete and excess schedules and counts only valid amounts', () => {
  assert.deepEqual(instalmentSummary('5000', rows('1500', '875', '875', '875', '875')), {
    target: 500000n, scheduled: 500000n, remaining: 0n, incomplete: false,
    paid: 0n, outstanding: 500000n, overdue: 0n,
    minimum: 499500n, maximum: 500500n, adjustment: 0n, withinTolerance: true,
  });
  assert.deepEqual(instalmentSummary('5000', rows('1500', '', '12.', '0', '1000')), {
    target: 500000n, scheduled: 250000n, remaining: 250000n, incomplete: true,
    paid: 0n, outstanding: 500000n, overdue: 0n,
    minimum: 499500n, maximum: 500500n, adjustment: 249500n, withinTolerance: false,
  });
  assert.deepEqual(instalmentSummary('100', rows('50', '55')), {
    target: 10000n, scheduled: 10500n, remaining: -500n, incomplete: false,
    paid: 0n, outstanding: 10000n, overdue: 0n,
    minimum: 9500n, maximum: 10500n, adjustment: 0n, withinTolerance: true,
  });
  assert.deepEqual(instalmentSummary('', rows('50', '55')), {
    target: null, scheduled: 10500n, remaining: null, incomplete: true,
    paid: 0n, outstanding: 0n, overdue: 0n,
    minimum: null, maximum: null, adjustment: null, withinTolerance: false,
  });
});

test('an empty schedule represents the implicit single payment at the calculation total', () => {
  assert.deepEqual(instalmentSummary('5000', []), {
    target: 500000n, scheduled: 500000n, remaining: 0n, incomplete: false,
    paid: 0n, outstanding: 500000n, overdue: 0n,
    minimum: 499500n, maximum: 500500n, adjustment: 0n, withinTolerance: true,
  });
  assert.deepEqual(instalmentSummary('', []), {
    target: null, scheduled: 0n, remaining: null, incomplete: true,
    paid: 0n, outstanding: 0n, overdue: 0n,
    minimum: null, maximum: null, adjustment: null, withinTolerance: false,
  });
});

test('the £5 tolerance includes both boundaries and reports the exact adjustment outside them', () => {
  for (const [amount, withinTolerance, adjustment, remaining] of [
    ['95', true, 0n, 500n], ['105', true, 0n, -500n],
    ['94.99', false, 1n, 501n], ['105.01', false, 1n, -501n],
    ['80', false, 1500n, 2000n], ['120', false, 1500n, -2000n],
  ] as const) {
    const summary = instalmentSummary('100', rows(amount));
    assert.equal(summary.withinTolerance, withinTolerance, amount);
    assert.equal(summary.adjustment, adjustment, amount);
    assert.equal(summary.remaining, remaining, amount);
    assert.equal(summary.minimum, 9500n);
    assert.equal(summary.maximum, 10500n);
  }
  const small = instalmentSummary('0.01', rows('0.01'));
  assert.equal(small.minimum, 0n);
  assert.equal(small.maximum, 501n);
  assert.equal(small.withinTolerance, true);
});

test('an unfinished amount prevents validation even when valid amounts already fit the range', () => {
  for (const amount of ['', '12.', '0', '-10']) {
    const summary = instalmentSummary('100', rows('100', amount));
    assert.equal(summary.scheduled, 10000n);
    assert.equal(summary.remaining, 0n);
    assert.equal(summary.adjustment, 0n);
    assert.equal(summary.incomplete, true);
    assert.equal(summary.withinTolerance, false);
  }
});

test('paid, outstanding and overdue amounts are independent of the schedule discrepancy', () => {
  const input: InstalmentRow[] = [
    { key: 'paid', amount: '1500', due_date: '2026-11-01', paid: true },
    { key: 'overdue', amount: '1000', due_date: '2026-11-10' },
    { key: 'today', amount: '500', due_date: '2026-11-11' },
    { key: 'future', amount: '2000', due_date: '2026-12-01' },
  ];
  const summary = instalmentSummary('5000', input, '2026-11-11');
  assert.equal(summary.scheduled, 500000n);
  assert.equal(summary.remaining, 0n);
  assert.equal(summary.paid, 150000n);
  assert.equal(summary.outstanding, 350000n);
  assert.equal(summary.overdue, 100000n);
  assert.equal(summary.withinTolerance, true);

  input[1].paid = true;
  const paidAnother = instalmentSummary('5000', input, '2026-11-11');
  assert.equal(paidAnother.remaining, 0n);
  assert.equal(paidAnother.paid, 250000n);
  assert.equal(paidAnother.outstanding, 250000n);
  assert.equal(paidAnother.overdue, 0n);

  input[3].amount = '2010';
  const overScheduled = instalmentSummary('5000', input, '2026-11-11');
  assert.equal(overScheduled.remaining, -1000n);
  assert.equal(overScheduled.adjustment, 500n);
  assert.equal(overScheduled.outstanding, 250000n);
  assert.equal(overScheduled.overdue, 0n);
});

test('invalid dates and partial amounts are excluded from overdue sums; outstanding never goes negative', () => {
  const input = rows('150', '12.', '20', '30');
  input[0].paid = true;
  input[1].due_date = '2026-01-01';
  input[2].due_date = '';
  input[3].due_date = '2026-02-30';
  const summary = instalmentSummary('100', input, '2026-11-11');
  assert.equal(summary.paid, 15000n);
  assert.equal(summary.outstanding, 0n);
  assert.equal(summary.overdue, 0n);
  assert.equal(summary.incomplete, true);
  assert.equal(instalmentSummary('100', rows('100')).overdue, 0n);
  assert.equal(instalmentSummary('100', rows('100'), 'invalid').overdue, 0n);
});

test('an existing payment must be selected before it reduces paid and overdue balances', () => {
  const input: InstalmentRow[] = [{ key: 'pending', amount: '100', due_date: '2026-01-01', paid: true, payment_choice: 'existing' }];
  const pending = instalmentSummary('100', input, '2026-11-11');
  assert.equal(pending.paid, 0n);
  assert.equal(pending.outstanding, 10000n);
  assert.equal(pending.overdue, 10000n);
  input[0].payment_entry_id = '123';
  const selected = instalmentSummary('100', input, '2026-11-11');
  assert.equal(selected.paid, 10000n);
  assert.equal(selected.outstanding, 0n);
  assert.equal(selected.overdue, 0n);
});
