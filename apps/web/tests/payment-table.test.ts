import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Payment } from "../src/payments/model";

const organizationId="11111111-1111-4111-8111-111111111111";
const payment:Payment={
  id:"44444444-4444-4444-8444-444444444444",customer_id:"22222222-2222-4222-8222-222222222222",
  customer_name:"Aster Studio",customer_code:"CU001",booking_id:"33333333-3333-4333-8333-333333333333",
  booking_reference:"TRIP-2026",amount_minor:"12550",currency:"GBP",payment_date:"2026-11-06",
  submitted_at:"2026-11-06T23:30:00Z",status:"pending",note:"Bank transfer AB123",reviewed_at:null,
  rejection_reason:null,ledger_entry_id:null,
  receipts:[{id:"55555555-5555-4555-8555-555555555555",name:"receipt.png",mime_type:"image/png",size:1234,url:"https://untrusted.test/receipt.png"}],
};

test("compact payment rows defer receipt loading and expose exactly two contextual actions", async () => {
  Object.defineProperty(globalThis,"window",{configurable:true,value:{location:{pathname:"/",search:"",hash:""}}});
  try {
    const {PaymentTable}=await import("../src/payments/PaymentTable");
    const render=(canReview:boolean,showCustomer:boolean,item=payment)=>renderToStaticMarkup(h(PaymentTable,{
      payments:[item],organizationId,timeZone:"Asia/Karachi",canReview,showCustomer,onOpen:()=>undefined,
    }));
    const admin=render(true,true);
    assert.match(admin,/<table/);
    assert.match(admin,/<caption/);
    assert.match(admin,/Aster Studio/);
    assert.match(admin,/GBP 125\.50/);
    assert.match(admin,/Added 07 Nov 2026/);
    assert.doesNotMatch(admin,/<img|untrusted\.test|\/receipts\//,"receipt bytes are only requested after opening details");
    const adminActions=admin.match(/<div class="payment-row-actions">([\s\S]*?)<\/div>/)![1];
    assert.equal((adminActions.match(/<(button|a)\b/g)||[]).length,2);
    assert.match(adminActions,/>Review<\/button>/);
    assert.match(adminActions,/>Booking<\/a>/);
    assert.match(adminActions,new RegExp(`/users/${payment.customer_id}/bookings/${payment.booking_id}`));
    const customerActions=render(false,false).match(/<div class="payment-row-actions">([\s\S]*?)<\/div>/)![1];
    assert.equal((customerActions.match(/<button\b/g)||[]).length,2);
    assert.match(customerActions,/>Details<\/button>/);
    assert.match(customerActions,/>Receipts<\/button>/);
    assert.doesNotMatch(customerActions,/>Review<\/button>|>Booking<\/a>/);
    const approved=render(true,true,{...payment,status:"approved"});
    assert.match(approved,/>Details<\/button>/);
    assert.doesNotMatch(approved,/>Review<\/button>/);
  } finally {Reflect.deleteProperty(globalThis,"window");}
});

test("payment details preserve private receipt addresses and role-gated review controls", async () => {
  Object.defineProperty(globalThis,"window",{configurable:true,value:{location:{pathname:"/",search:"",hash:""}}});
  try {
    const {PaymentDetailsDialog}=await import("../src/payments/PaymentTable");
    const render=(canReview:boolean)=>renderToStaticMarkup(h(PaymentDetailsDialog,{
      payment,organizationId,timeZone:"Asia/Karachi",canReview,onClose:()=>undefined,onReviewed:()=>undefined,
    }));
    const admin=render(true);
    assert.match(admin,/<dialog[^>]+aria-labelledby="[^"]+"/);
    assert.match(admin,/>Review payment<\/h2>/);
    assert.match(admin,/Approve payment/);
    assert.match(admin,/Reject submission/);
    assert.match(admin,/has not changed the account balance/);
    assert.match(admin,/Loading receipt.png/);
    assert.doesNotMatch(admin,/(?:src|href)="\/api\//);
    assert.doesNotMatch(admin,/untrusted\.test/);
    const customer=render(false);
    assert.match(customer,/>Payment details<\/h2>/);
    assert.doesNotMatch(customer,/Approve payment|Reject submission/);
  } finally {Reflect.deleteProperty(globalThis,"window");}
});
