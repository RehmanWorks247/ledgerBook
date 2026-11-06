import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { currencyExponent } from '../../api/src/currency/math';

test('all currency consumers update from one context and unavailable rates never relabel accounting amounts', async () => {
  Object.defineProperty(globalThis,'window',{ configurable:true, value:{location:{pathname:'/',search:'',hash:''}} });
  try {
    const { formatConvertedMoney, CurrencyContext, useMoney } = await import('../src/currency');
    const data = { base_currency:'USD',base_exponent:2,display_currency:'PKR',fetched_at:null,unavailable:false,
      currencies:[{code:'PKR',name:'Pakistani Rupee',exponent:2,available:true,rate:'277.12'}] };
    assert.equal(currencyExponent('PKR'),2);
    assert.equal(currencyExponent('JPY'),0);
    assert.equal(currencyExponent('KWD'),3);
    assert.equal(formatConvertedMoney('1234','USD',2,data),'PKR 3,419.66');
    assert.equal(formatConvertedMoney('-1','USD',2,data),'−PKR 2.77');
    assert.equal(formatConvertedMoney('1234','USD',2,{...data,display_currency:'USD'}),'USD 12.34');
    assert.equal(formatConvertedMoney('1234','USD',2,{...data,currencies:[]}),'PKR — rate unavailable');
    function Consumer() { const format = useMoney(); return createElement('span',null,format('1234','USD',2)); }
    const render = (rate:string) => renderToStaticMarkup(createElement(CurrencyContext.Provider,{value:{data:{...data,
      currencies:[{...data.currencies[0],rate}]},error:'',busy:false,refresh:async()=>{},select:async()=>{},override:async()=>{}}},
      createElement('div',null,createElement(Consumer),createElement(Consumer))));
    assert.equal((render('277.12').match(/PKR 3,419.66/g)??[]).length,2);
    assert.equal((render('280').match(/PKR 3,455.20/g)??[]).length,2);
  } finally { Reflect.deleteProperty(globalThis,'window'); }
});

test('travel ledger always displays GBP and never relabels legacy accounting amounts', async () => {
  Object.defineProperty(globalThis,'window',{ configurable:true, value:{location:{pathname:'/',search:'',hash:''}} });
  try {
    const { formatLedgerMoney } = await import('../src/currency');
    const data = { base_currency:'USD',base_exponent:2,display_currency:'PKR',fetched_at:null,unavailable:false,
      currencies:[{code:'GBP',name:'Pound sterling',exponent:2,available:true,rate:'0.8'}] };
    assert.equal(formatLedgerMoney('12345','GBP',2,data),'GBP 123.45');
    assert.equal(formatLedgerMoney('12345','USD',2,data),'GBP 98.76');
    assert.equal(formatLedgerMoney('-125','USD',2,data),'−GBP 1.00');
    assert.equal(formatLedgerMoney('12345','USD',2),'GBP — rate unavailable');
    assert.equal(formatLedgerMoney('12345','USD',2,{...data,currencies:[]}),'GBP — rate unavailable');
  } finally { Reflect.deleteProperty(globalThis,'window'); }
});
