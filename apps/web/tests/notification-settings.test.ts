import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { deliveryLabel,NotificationDeliveryTable,type DeliveryMessage } from '../src/NotificationSettings';

test('delivery labels distinguish provider acceptance, mail-server delivery and retried queue entries',()=>{
  assert.equal(deliveryLabel({state:'sent',delivery_status:'accepted',attempts:1}),'Sent · awaiting delivery');
  assert.equal(deliveryLabel({state:'sent',delivery_status:'delivered',attempts:1}),'Delivered to mail server');
  assert.equal(deliveryLabel({state:'pending',delivery_status:'queued',attempts:2}),'Retry scheduled');
  assert.equal(deliveryLabel({state:'sent',delivery_status:'bounced',attempts:1}),'Bounced');
});
test('delivery history safely escapes subjects and recipients without leaking message bodies',()=>{
  const message:DeliveryMessage={id:'id',kind:'reminder',recipient:'<script>@example.test',subject:'<img src=x onerror=alert(1)>',state:'sent',delivery_status:'delivered',attempts:1,
    last_error:null,created_at:'2026-11-09T12:00:00Z',delivery_updated_at:'2026-11-09T12:01:00Z'};
  const html=renderToStaticMarkup(createElement(NotificationDeliveryTable,{messages:[message]}));
  assert.match(html,/Delivered to mail server/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script|<img/);
  assert.match(renderToStaticMarkup(createElement(NotificationDeliveryTable,{messages:[]})),/No payment emails or reminders/);
});
