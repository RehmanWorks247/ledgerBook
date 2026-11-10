import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bookingAmountInput, departureInstant, departureLocal } from '../src/pages/booking-model';

test('booking edits preserve exact penny amounts without floating-point conversion',()=>{
  assert.equal(bookingAmountInput('1'),'0.01');
  assert.equal(bookingAmountInput('100000000000000'),'1000000000000.00');
  assert.equal(bookingAmountInput('125099'),'1250.99');
});

test('existing departures populate the business time zone and round-trip across UTC dates',()=>{
  const value='2026-11-12T23:30:00.000Z';
  assert.equal(departureLocal(value,'Asia/Karachi'),'2026-11-13T04:30');
  assert.equal(departureInstant(departureLocal(value,'Asia/Karachi'),'Asia/Karachi'),value);
  assert.equal(departureLocal('2026-06-01T12:00:00Z','Europe/London'),'2026-06-01T13:00');
});
