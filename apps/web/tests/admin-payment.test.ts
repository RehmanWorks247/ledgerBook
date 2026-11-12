import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { setTokenProvider } from '../src/api';
import { AdminPaymentRecorder } from '../src/payments/admin-payment';
import { AdminPaymentForm } from '../src/payments/AdminPaymentForm';

const context={organizationId:'11111111-1111-4111-8111-111111111111',customerId:'22222222-2222-4222-8222-222222222222',bookingId:'33333333-3333-4333-8333-333333333333'};
const draft={amount:'300.00',paymentDate:'2026-11-01',note:'Previous transfer'};
const payment={id:'44444444-4444-4444-8444-444444444444',status:'approved'};

test('recorded payments retry with the same key after a lost response, then reset after success',async()=>{
  const originalFetch=globalThis.fetch,keys:string[]=[];
  let lost=true;
  setTokenProvider(async()=>'record-session');
  globalThis.fetch=async(input,options={})=>{
    assert.equal(input,`/api/organizations/${context.organizationId}/customers/${context.customerId}/bookings/${context.bookingId}/payments/record`);
    assert.equal(options.method,'POST');assert.equal(options.credentials,'include');
    const headers=new Headers(options.headers);
    assert.equal(headers.get('Authorization'),'Bearer record-session');assert.equal(headers.get('X-CSRF-Protection'),'1');
    const data=JSON.parse(options.body as string);keys.push(data.idempotency_key);
    assert.equal(data.amount,'300.00');assert.equal(data.payment_date,'2026-11-01');assert.equal(data.note,'Previous transfer');
    assert.equal('files' in data,false);
    if(lost){lost=false;throw new Error('Response lost');}
    return Response.json(payment);
  };
  try {
    const recorder=new AdminPaymentRecorder(context);
    await assert.rejects(recorder.record(draft,'2026-11-12'),/Response lost/);
    assert.equal((await recorder.record(draft,'2026-11-12')).id,payment.id);
    assert.equal(keys[0],keys[1]);
    await recorder.record(draft,'2026-11-12');assert.notEqual(keys[1],keys[2]);
  } finally {globalThis.fetch=originalFetch;setTokenProvider(async()=>null);}
});

test('existing payments send only the selected entry and retry key, never replacement amount/date',async()=>{
  const originalFetch=globalThis.fetch,keys:string[]=[];
  globalThis.fetch=async(input,options={})=>{
    assert.match(String(input),/\/payments\/link$/);
    const data=JSON.parse(options.body as string);assert.deepEqual(Object.keys(data).sort(),['idempotency_key','payment_entry_id']);
    assert.equal(data.payment_entry_id,'73');keys.push(data.idempotency_key);
    return Response.json({message:'Try again'},{status:503});
  };
  try {
    const recorder=new AdminPaymentRecorder(context);
    await assert.rejects(recorder.link('73'),/Try again/);await assert.rejects(recorder.link('73'),/Try again/);
    assert.equal(keys[0],keys[1]);
    await assert.rejects(recorder.link('bad'),/Choose an existing payment/);
    await assert.rejects(recorder.link('9223372036854775808'),/Choose an existing payment/);
    assert.equal(keys.length,2);
  } finally {globalThis.fetch=originalFetch;}
});

test('invalid money or future dates fail before network writes; changing a failed draft uses a new key',async()=>{
  const originalFetch=globalThis.fetch,keys:string[]=[];
  globalThis.fetch=async(_input,options={})=>{keys.push(JSON.parse(options.body as string).idempotency_key);throw new Error('Unavailable');};
  try {
    const recorder=new AdminPaymentRecorder(context);
    await assert.rejects(recorder.record({...draft,amount:'0'},'2026-11-12'),/positive/);
    await assert.rejects(recorder.record({...draft,paymentDate:'2026-11-13'},'2026-11-12'),/future/);
    assert.equal(keys.length,0);
    await assert.rejects(recorder.record(draft,'2026-11-12'),/Unavailable/);
    await assert.rejects(recorder.record({...draft,amount:'301.00'},'2026-11-12'),/Unavailable/);
    assert.notEqual(keys[0],keys[1]);
  } finally {globalThis.fetch=originalFetch;}
});

test('record form asks only for received money, actual date and optional note',()=>{
  const html=renderToStaticMarkup(createElement(AdminPaymentForm,{...context,timeZone:'UTC',mode:'record',onRecorded:()=>{},onCancel:()=>{}}));
  assert.match(html,/Record booking payment/);assert.match(html,/Amount received \(GBP\)/);assert.match(html,/Date received/);assert.match(html,/optional/);
  assert.match(html,/counts toward Paid so far immediately/);
  assert.doesNotMatch(html,/receipt files|checkbox|instalment|installment|auto.balance|payment.source/i);
});
