import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('dashboard links select the correct booking, customer, payment workflow and ledger period', async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { pathname: '/', search: '', hash: '' } } });
  try {
    const { recordLink, bookingLink, paymentLink, ledgerFilters, timestamp } = await import('../src/pages/Dashboard');
    assert.equal(recordLink('/o/agency', 'guest'), '/o/agency/users/guest');
    assert.equal(bookingLink('/o/agency', 'guest', 'trip-2'), '/o/agency/users/guest/bookings/trip-2');
    assert.equal(paymentLink('/o/agency', 'guest'), '/o/agency/customers/guest/payments/new');
    assert.deepEqual(ledgerFilters('kind=payment&start=2026-11-01&end=2026-11-06'), {
      kind: 'payment', start: '2026-11-01', end: '2026-11-06', status: 'all', search: '', min_balance: '', max_balance: '',
    });
    assert.equal(ledgerFilters('status=outstanding').status, 'outstanding');
    assert.equal(ledgerFilters('status=overdue').status, 'overdue');
    assert.match(timestamp('2026-11-06T23:30:00Z', 'Asia/Karachi'), /07 Nov.*04:30/);
  } finally { Reflect.deleteProperty(globalThis, 'window'); }
});

test('query-string ledger links match the route and retain selected filters', async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { pathname: '/o/agency/customer-ledger', search: '?status=overdue', hash: '' } } });
  try {
    const { BrowserRouter, Routes, Route, useSearch } = await import('../src/router');
    const View = () => h('p', null, useSearch());
    const html = renderToStaticMarkup(h(BrowserRouter, { children: h(Routes, { children: h(Route, { path: '/o/:orgId/customer-ledger', element: h(View) }) }) }));
    assert.equal(html, '<p>status=overdue</p>');
  } finally { Reflect.deleteProperty(globalThis, 'window'); }
});


test('period presets respect month boundaries, leap years and inclusive 30-day ranges', async () => {
  const { presetPeriod } = await import('../src/PeriodPicker');
  assert.deepEqual(presetPeriod('2026-01-06', 'previous'), { start: '2025-12-01', end: '2025-12-31' });
  assert.deepEqual(presetPeriod('2024-02-29', 'month'), { start: '2024-02-01', end: '2024-02-29' });
  assert.deepEqual(presetPeriod('2026-03-01', '30days'), { start: '2026-01-31', end: '2026-03-01' });
});
