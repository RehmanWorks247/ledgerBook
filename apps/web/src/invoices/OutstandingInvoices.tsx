import { useState } from 'react';
import { Eye } from 'lucide-react';
import { money } from '../api';
import { Empty, ErrorNotice } from '../components';
import { FilePreviewModal } from '../file-preview/FilePreviewModal';
import { bookingInvoicesPath, invoiceFilename } from './model';
import type { OutstandingInvoice } from './outstanding';

export function OutstandingInvoices({organizationId,customerId,invoices,loading,error,onRefresh,onPay}: {
  organizationId:string;customerId:string;invoices:OutstandingInvoice[];loading:boolean;error:string;
  onRefresh:()=>void;onPay:(invoice:OutstandingInvoice)=>void;
}) {
  const [preview,setPreview]=useState<OutstandingInvoice|null>(null);
  return <section className="customer-account-invoices" aria-labelledby="outstanding-invoices-title" aria-busy={loading}>
    <div className="customer-account-section-heading"><h2 id="outstanding-invoices-title">Outstanding invoices</h2><p>The latest invoice for each booking with an amount left to pay.</p></div>
    {error?<><ErrorNotice message={error}/><button type="button" className="button secondary" onClick={onRefresh}>Reload invoices</button></>
      :loading?<p role="status">Loading invoices…</p>
      :!invoices.length?<Empty title="No outstanding invoices" detail="There are no current booking invoices left to pay."/>
      :<div className="customer-account-payment-grid">{invoices.map((invoice,index)=><article className="panel customer-account-payment-card" key={invoice.id}>
        <div><strong>{invoice.invoice_number}</strong><span>{index===0?'Latest outstanding':'Latest version'}</span></div>
        <p>Booking {invoice.booking_reference} · Version {invoice.version}</p>
        <p><strong>{money(invoice.outstanding_minor,invoice.currency,2)}</strong> left to pay</p>
        <div className="payment-actions"><button type="button" className="button" onClick={()=>onPay(invoice)}>Pay this invoice</button>
          <button type="button" className="button secondary" onClick={()=>setPreview(invoice)} aria-label={`View invoice ${invoice.invoice_number}`}><Eye size={15}/>View invoice</button></div>
      </article>)}</div>}
    {preview&&<FilePreviewModal key={preview.id} file={{name:invoiceFilename(preview),mimeType:'application/pdf',
      url:`/api${bookingInvoicesPath({organizationId,customerId,bookingId:preview.booking_id})}/${preview.id}/pdf`}} onClose={()=>setPreview(null)}/>}
  </section>;
}
