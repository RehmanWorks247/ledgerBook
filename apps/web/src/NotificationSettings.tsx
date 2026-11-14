import { useEffect, useState, type FormEvent } from 'react';
import { errorMessage, mutate, useResource, type Customer } from './api';
import { ErrorNotice, FormSkeleton } from './components';
import { CustomerPicker } from './CustomerPicker';
import { useOrganization } from './state';

type Settings={version:number;enabled:boolean;due_soon_days:number;repeat_days:number;send_hour:number;time_zone:string;updated_at?:string;
  last_scheduled_date:string|null;email_mode:string;delivery_tracking_configured:boolean};
export type DeliveryMessage={id:string;kind:string;recipient:string;subject:string;state:string;delivery_status:string;
  attempts:number;last_error:string|null;created_at:string;delivery_updated_at:string|null};
type History={summary:{queued:number;retrying:number;sent:number;delivered:number;bounced:number;complained:number;failed:number;suppressed:number;oldest_queued_at:string|null};
  messages:DeliveryMessage[];last_delivery_update_at:string|null};
const labels:Record<string,string>={queued:'Queued',accepted:'Sent · awaiting delivery',delivered:'Delivered to mail server',delayed:'Delivery delayed',
  bounced:'Bounced',complained:'Spam complaint',failed:'Failed · needs attention',suppressed:'Suppressed',cancelled:'Cancelled'};
export function deliveryLabel(message:Pick<DeliveryMessage,'state'|'delivery_status'|'attempts'>) {
  if(message.state==='pending' && message.attempts>0)return 'Retry scheduled';
  if(message.state==='processing')return 'Sending';
  return labels[message.delivery_status]??'Unknown';
}

export function NotificationDeliveryTable({messages}:{messages:DeliveryMessage[]}) {
  if(!messages.length)return <p className="muted">No payment emails or reminders have been queued yet.</p>;
  return <div className="table-scroll"><table><thead><tr><th>Recipient</th><th>Notification</th><th>Status</th><th>Queued</th></tr></thead>
    <tbody>{messages.map(message=><tr key={`${message.kind}:${message.id}`}><td>{message.recipient}</td><td>{message.subject}<small className="muted"> · {message.kind}</small></td>
      <td><span>{deliveryLabel(message)}</span>{message.last_error&&<small className="muted"> {message.last_error}</small>}</td>
      <td>{new Date(message.created_at).toLocaleString()}</td></tr>)}</tbody></table></div>;
}

function ReminderPreference({customerId}:{customerId:string}) {
  const member=useOrganization();
  const path=`/organizations/${member.organization_id}/customers/${customerId}/reminder-preferences`;
  const resource=useResource<{enabled:boolean;suppressed:boolean}>(path);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [checked,setChecked]=useState<boolean>();
  useEffect(()=>{if(resource.data)setChecked(resource.data.enabled);},[resource.data]);
  async function toggle(enabled:boolean) {
    const previous=checked??resource.data?.enabled??true;setChecked(enabled);
    setBusy(true);setError('');setNotice('');
    try {await mutate(path,{enabled},'PATCH');resource.refresh();setNotice(enabled?'Payment reminders enabled.':'Payment reminders turned off.');}
    catch(error){setChecked(previous);setError(errorMessage(error));}finally{setBusy(false);}
  }
  return <><ErrorNotice message={error||resource.error}/>{resource.loading&&!resource.data?<FormSkeleton/>:resource.data&&<>
    <label className="checkbox-label"><input type="checkbox" checked={checked??resource.data.enabled} disabled={busy||resource.loading}
      onChange={event=>{void toggle(event.target.checked);}}/> Receive automatic payment reminders</label>
    {resource.data.suppressed&&<p className="notice">Delivery is paused for this email address after a bounce or spam complaint. Contact the administrator to correct the address with the email provider.</p>}
    <p className="muted">This preference applies to due and overdue reminders, which stop when nothing is left to pay. Departure emails arrive three days before travel to prepare your luggage and six hours before travel to prepare for your taxi and the airport. No departure reminders are sent after departure.</p>
  </>}<p role="status">{notice}</p></>;
}

function SettingsForm({settings,onSaved}:{settings:Settings;onSaved:()=>void}) {
  const member=useOrganization();
  const [value,setValue]=useState(settings),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[dirty,setDirty]=useState(false);
  useEffect(()=>{if(!dirty)setValue(settings);},[settings]);
  const update=(next:Settings)=>{setValue(next);setDirty(true);};
  async function save(event:FormEvent) {
    event.preventDefault();setBusy(true);setError('');setNotice('');
    try {
      const {enabled,due_soon_days,repeat_days,send_hour,time_zone}=value;
      const saved=await mutate<Settings>(`/organizations/${member.organization_id}/notifications/settings`,{enabled,due_soon_days,repeat_days,send_hour,time_zone,expected_version:value.version},'PATCH');
      setValue(saved);setDirty(false);
      setNotice('Reminder schedule saved.');onSaved();
    } catch(error){setError(errorMessage(error));onSaved();}finally{setBusy(false);}
  }
  return <form onSubmit={save}><ErrorNotice message={error}/>{dirty && value.version!==settings.version && <p className="notice">A newer schedule was saved in another session. <button type="button" className="button secondary small" disabled={busy} onClick={()=>{setValue(settings);setDirty(false);setError('');}}>Reload saved schedule</button></p>}<fieldset disabled={busy} className="appearance-fieldset">
    <legend>Automatic payment reminders</legend>
    <label className="checkbox-label"><input type="checkbox" checked={value.enabled} onChange={event=>update({...value,enabled:event.target.checked})}/>
      Enable due and overdue reminders for this workspace</label>
    <p className="muted">Reminders start only after you enable them. Customers with an outstanding booking balance receive at most one reminder during each repeat interval. Settled, cancelled, archived and opted-out accounts are skipped.</p>
    <div className="form-grid">
      <label>Days before payment is due<input type="number" min={0} max={14} required value={value.due_soon_days} onChange={event=>update({...value,due_soon_days:Number(event.target.value)})}/></label>
      <label>Repeat no sooner than (days)<input type="number" min={1} max={30} required value={value.repeat_days} onChange={event=>update({...value,repeat_days:Number(event.target.value)})}/></label>
      <label>Daily send hour<select value={value.send_hour} onChange={event=>update({...value,send_hour:Number(event.target.value)})}>
        {Array.from({length:24},(_,hour)=><option key={hour} value={hour}>{String(hour).padStart(2,'0')}:00</option>)}</select></label>
      <label>Time zone<input required maxLength={100} value={value.time_zone} placeholder="Europe/London" onChange={event=>update({...value,time_zone:event.target.value})}/></label>
    </div></fieldset><button className="button primary" disabled={busy}>{busy?'Saving…':'Save reminder schedule'}</button><p role="status">{notice}</p></form>;
}

function AdminNotificationSettings() {
  const member=useOrganization(),path=`/organizations/${member.organization_id}/notifications`;
  const settings=useResource<Settings>(`${path}/settings`),history=useResource<History>(`${path}/history`);
  const [customer,setCustomer]=useState<Customer|null>(null);
  const refresh=()=>{settings.refresh();history.refresh();};
  return <section className="panel currency-settings" aria-labelledby="notification-settings-title">
    <header><div><h2 id="notification-settings-title">Notifications & reminders</h2><p>Manage automatic reminders and check payment email delivery.</p></div>
      <button className="button secondary small" onClick={refresh}>Refresh notifications</button></header>
    <ErrorNotice message={settings.error||history.error}/>
    {settings.loading&&!settings.data?<FormSkeleton/>:settings.data&&<>
      {settings.data.email_mode==='file'?<p className="notice">Local email mode: messages are saved to email files. No real email is sent.</p>:
        !settings.data.delivery_tracking_configured&&<p className="notice">Delivery tracking needs the Resend webhook connection. Sent means the provider accepted the request; delivery is unconfirmed until a verified event arrives.</p>}
      <SettingsForm key={member.organization_id} settings={settings.data} onSaved={refresh}/>
      <p className="muted">Last scheduled scan: {settings.data.last_scheduled_date?.slice(0,10)??'Not run yet'} · {settings.data.time_zone}</p>
    </>}
    <h3>Departure reminders</h3><p className="muted">Automatic emails remind customers to prepare their luggage three days before departure and get ready for their taxi and the airport six hours before departure. Each is sent once for the scheduled departure. Cancelled trips and past departures are skipped. These emails are independent of payment reminders.</p>
    <h3>Customer reminder preferences</h3><CustomerPicker onSelect={setCustomer} activeOnly={false}/>
    {customer&&<ReminderPreference key={customer.id} customerId={customer.id}/>}
    <h3>Delivery activity</h3><p className="muted">Sent confirms provider acceptance. Delivered confirms the recipient’s mail server accepted the email; it does not confirm that the email was read. Bounces and spam complaints automatically suppress future delivery.</p>
    {history.data&&<><p aria-live="polite">{history.data.summary.queued} queued · {history.data.summary.retrying} retrying · {history.data.summary.sent} sent · {history.data.summary.delivered} delivered · {history.data.summary.bounced} bounced · {history.data.summary.failed} failed · {history.data.summary.complained} complaints</p>
      <NotificationDeliveryTable messages={history.data.messages}/><p className="muted">Showing the latest 100 messages.</p></>}
  </section>;
}

export function NotificationSettings() {
  const member=useOrganization();
  if(member.role==='admin')return <AdminNotificationSettings key={member.organization_id}/>;
  if(!member.customer_id)return null;
  return <section className="panel currency-settings"><h2>Payment reminders</h2><ReminderPreference key={member.customer_id} customerId={member.customer_id}/></section>;
}
