import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import type { DemoCustomer, DemoPayment, DemoService as DemoServiceKey } from './demo-data';

export type DemoDocument = {serviceKey:DemoServiceKey;name:string;content:Buffer};
const PAGE_HEIGHT=841.8898;
const template=readFileSync(resolve(__dirname,'demo-document-assets/template.pdf'));
const colors={ink:'#102f3c',muted:'#5c6b72',teal:'#24796a',line:'#d6dfe2',light:'#f2f6f7',amber:'#fff0c2'};

function ascii(value:unknown) {
  return String(value??'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^\x20-\x7e]/g,' ');
}
function pdfString(value:unknown) {return ascii(value).replace(/[\\()]/g,'\\$&');}
function rgb(hex:string) {return hex.replace('#','').match(/../g)!.map(pair=>(parseInt(pair,16)/255).toFixed(4)).join(' ');}
function width(value:string,size:number) {
  return Array.from(ascii(value)).reduce((total,char)=>total+("ilI.,:;'!| ".includes(char)?0.28:'MW@%'.includes(char)?0.84:0.56),0)*size;
}
function wrap(value:string,size:number,maxWidth:number) {
  const lines:string[]=[];
  let line='';
  for(const word of ascii(value).split(/\s+/).filter(Boolean)) {
    if(line && width(`${line} ${word}`,size)>maxWidth) {lines.push(line);line=word;}
    else line=line?`${line} ${word}`:word;
  }
  if(line) lines.push(line);
  return lines;
}
function date(value:string) {
  const instant=new Date(value.length===10?`${value}T12:00:00Z`:value);
  if(!Number.isFinite(instant.getTime())) throw new Error('Demo document requires valid dates.');
  return new Intl.DateTimeFormat('en-GB',{day:'2-digit',month:'short',year:'numeric',timeZone:'UTC'}).format(instant);
}
function dateTime(value:string) {
  const instant=new Date(value);
  return `${date(value)} ${instant.toISOString().slice(11,16)} UTC`;
}
function addHours(value:string,hours:number) {return new Date(Date.parse(value)+hours*3_600_000).toISOString();}
function money(value:string) {
  const minor=BigInt(value);
  return `GBP ${(minor/100n).toLocaleString('en-GB')}.${(minor%100n).toString().padStart(2,'0')}`;
}

/** Append an ordinary PDF revision to the ReportLab background, preserving its fonts and valid xref chain. */
function finishPdf(commands:string[],title:string):Buffer {
  const original=template.toString('latin1');
  const page=Array.from(original.matchAll(/(\d+) 0 obj\s*([\s\S]*?)\s*endobj/g)).find(match=>/\/Type\s*\/Page\b/.test(match[2]));
  const previous=/startxref\s+(\d+)\s+%%EOF\s*$/.exec(original)?.[1];
  const root=/\/Root\s+(\d+) 0 R/.exec(original)?.[1];
  const size=Number(/\/Size\s+(\d+)/.exec(original)?.[1]);
  const existingContent=page && /\/Contents\s+(\d+) 0 R/.exec(page[2])?.[1];
  if(!page || !previous || !root || !size || !existingContent) throw new Error('The demo PDF template is invalid; rebuild it with create-template.py.');
  const pageId=Number(page[1]),streamId=size,infoId=size+1;
  const stream=Buffer.from(`q\n${commands.join('\n')}\nQ\n`,'ascii');
  const objects:[number,Buffer][]=[
    [pageId,Buffer.from(page[2].replace(/\/Contents\s+\d+ 0 R/,`/Contents [${existingContent} 0 R ${streamId} 0 R]`),'ascii')],
    [streamId,Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`),stream,Buffer.from('endstream')])],
    [infoId,Buffer.from(`<< /Title (${pdfString(title)}) /Author (Sample Horizon Journeys - fictional agency) /Subject (SAMPLE - NOT VALID FOR TRAVEL) /Producer (LedgerBook demo documents with ReportLab template) >>`,'ascii')],
  ];
  const chunks:Buffer[]=[template,Buffer.from('\n')];
  const offsets=new Map<number,number>();
  let length=template.length+1;
  for(const [id,body] of objects) {
    offsets.set(id,length);
    const chunk=Buffer.concat([Buffer.from(`${id} 0 obj\n`),body,Buffer.from('\nendobj\n')]);
    chunks.push(chunk);length+=chunk.length;
  }
  const xref=length;
  const entry=(id:number)=>`${String(offsets.get(id)).padStart(10,'0')} 00000 n \n`;
  chunks.push(Buffer.from(`xref\n0 1\n0000000000 65535 f \n${pageId} 1\n${entry(pageId)}${streamId} 2\n${entry(streamId)}${entry(infoId)}trailer\n<< /Size ${infoId+1} /Root ${root} 0 R /Info ${infoId} 0 R /Prev ${previous} >>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

class Page {
  private readonly commands:string[]=[];
  text(value:unknown,x:number,top:number,size=10,bold=false,color=colors.ink,maxWidth=515) {
    const safe=ascii(value);
    const fit=Math.min(size,maxWidth/Math.max(width(safe,1),1));
    this.commands.push(`${rgb(color)} rg BT /${bold?'F2':'F1'} ${fit.toFixed(2)} Tf 1 0 0 1 ${x} ${(PAGE_HEIGHT-top).toFixed(3)} Tm (${pdfString(safe)}) Tj ET`);
    return this;
  }
  block(value:string,x:number,top:number,maxWidth=515,size=10,lineHeight=14,color=colors.muted) {
    const lines=wrap(value,size,maxWidth);
    lines.forEach((line,index)=>this.text(line,x,top+index*lineHeight,size,false,color,maxWidth));
    return top+lines.length*lineHeight;
  }
  rect(x:number,top:number,w:number,h:number,fill=colors.light) {
    this.commands.push(`${rgb(fill)} rg ${x} ${(PAGE_HEIGHT-top-h).toFixed(3)} ${w} ${h} re f`);return this;
  }
  line(x1:number,top:number,x2:number,color=colors.line) {
    this.commands.push(`${rgb(color)} RG 0.6 w ${x1} ${(PAGE_HEIGHT-top).toFixed(3)} m ${x2} ${(PAGE_HEIGHT-top).toFixed(3)} l S`);return this;
  }
  heading(value:string,top:number) {return this.text(value.toUpperCase(),40,top,9,true,colors.teal);}
  finish(title:string) {return finishPdf(this.commands,title);}
}

function introduction(customer:DemoCustomer,title:string,service:DemoServiceKey) {
  const page=new Page();
  const booking=customer.booking;
  const issued=booking.issuedServices.includes(service);
  page.text(title,40,181,23,true,colors.ink,345);
  page.rect(414,160,141,28,issued?'#e3f0eb':colors.amber)
    .text(issued?'ISSUED SAMPLE':'DRAFT SAMPLE',425,178,9,true,issued?colors.teal:'#654900',120);
  page.text(`BOOKING ${booking.reference}  |  Created ${date(booking.bookedOn)}`,40,202,10,false,colors.muted);
  page.rect(40,218,515,62);
  page.text('LEAD TRAVELLER',54,238,8,true,colors.muted).text(customer.name,54,259,12,true,colors.ink,214);
  page.text('TRAVELLERS',289,238,8,true,colors.muted).text(`${booking.passengers.length} guest${booking.passengers.length===1?'':'s'}`,289,259,12,true);
  const shortPackage=booking.packageName.replace(/\s*[-\u2014]\s*sample itinerary$/i,'');
  page.text('PACKAGE',389,238,8,true,colors.muted).text(shortPackage,389,259,10,true,colors.ink,151);
  return page;
}

function passengerTable(page:Page,customer:DemoCustomer,top:number) {
  const passengers=customer.booking.passengers;
  if(passengers.length>8) throw new Error('Sample documents support up to eight travellers per booking.');
  page.heading('Sample traveller manifest',top);
  page.rect(40,top+12,515,23).text('TRAVELLER',50,top+28,8,true,colors.muted)
    .text('CATEGORY',300,top+28,8,true,colors.muted).text('DEMO REFERENCE',400,top+28,8,true,colors.muted);
  const rowHeight=passengers.length>6?16:19;
  passengers.forEach((passenger,index)=>{
    const y=top+51+index*rowHeight;
    page.text(passenger.name,50,y,9.5,false,colors.ink,236)
      .text(`${passenger.category==='child'?'Child':'Adult'} / ${passenger.age} years`,300,y,9,false,colors.muted,90)
      .text(passenger.documentReference,400,y,8.5,false,colors.muted,145).line(40,y+7,555);
  });
  return top+44+passengers.length*rowHeight;
}

export function flightDocument(customer:DemoCustomer):Buffer {
  const b=customer.booking;
  const page=introduction(customer,'Flight itinerary','flight');
  function segment(top:number,label:string,origin:string,originName:string,destination:string,destinationName:string,departure:string,arrival:string,flight:string) {
    page.rect(40,top,515,114).text(label,54,top+18,8,true,colors.teal)
      .text(origin,54,top+49,26,true).text(destination,411,top+49,26,true)
      .text(originName,54,top+66,9,false,colors.muted,155).text(destinationName,383,top+66,9,false,colors.muted,157)
      .text(b.airline,217,top+40,9,true,colors.ink,166)
      .text(b.route.viaCode?`Via ${b.route.viaCode}`:'Direct sample routing',217,top+58,8.5,false,colors.muted,166)
      .text(`Departure  ${dateTime(departure)}`,54,top+88,8.5,false,colors.ink,280)
      .text(`Arrival  ${dateTime(arrival)}`,54,top+103,8.5,false,colors.ink,280)
      .text(`Flight ${flight}  /  Economy`,343,top+97,8.5,true,colors.ink,196);
  }
  page.heading('Outbound and return journeys',303);
  segment(315,'OUTBOUND',b.route.originCode,b.route.originName,b.route.arrivalCode,b.route.arrivalName,b.departureAt,b.arrivalAt,b.flightNumbers.outbound);
  segment(443,'RETURN',b.route.returnOriginCode,b.route.returnOriginName,b.route.originCode,b.route.originName,b.returnAt,b.returnArrivalAt,b.flightNumbers.return);
  passengerTable(page,customer,580);
  page.block('Sample allowance: one checked bag up to 23 kg and one cabin bag up to 7 kg per adult. All times shown in UTC. This demonstration itinerary is not an airline ticket or a confirmed reservation.',40,755,515,8.5,12);
  return page.finish(`SAMPLE flight itinerary - ${b.reference}`);
}

export function hotelDocument(customer:DemoCustomer,service:'makkah'|'madinah'):Buffer {
  const b=customer.booking,makkah=service==='makkah';
  const city=makkah?'Makkah':'Madinah';
  const hotel=makkah?b.makkahHotel:b.madinahHotel;
  const checkIn=makkah?b.makkahCheckIn:b.madinahCheckIn,checkOut=makkah?b.makkahCheckOut:b.madinahCheckOut;
  const nights=makkah?b.makkahNights:b.madinahNights;
  const page=introduction(customer,'Hotel accommodation',service);
  page.heading(`${city} stay`,303).text(hotel,40,334,22,true,colors.ink,515)
    .text(`Fictional property in ${city}, Saudi Arabia  |  Sample reservation only`,40,355,9.5,false,colors.muted);
  page.rect(40,374,247,70).rect(308,374,247,70);
  page.text('CHECK-IN',54,395,8,true,colors.muted).text(date(checkIn),54,418,17,true).text('From 15:00 local hotel time',54,434,8.5,false,colors.muted);
  page.text('CHECK-OUT',322,395,8,true,colors.muted).text(date(checkOut),322,418,17,true).text('Before 12:00 local hotel time',322,434,8.5,false,colors.muted);
  page.heading('Room and stay details',470);
  const details=[['Accommodation',b.roomType],['Stay duration',`${nights} night${nights===1?'':'s'} / ${b.passengers.length} guest${b.passengers.length===1?'':'s'}`],['Meal plan','Breakfast included in sample package'],['Reservation code',`SAMPLE-${b.reference}-${service.toUpperCase()}`]];
  details.forEach(([label,value],index)=>page.text(label,40,494+index*20,9,false,colors.muted,145).text(value,195,494+index*20,10,true,colors.ink,360));
  passengerTable(page,customer,583);
  page.block('This voucher demonstrates the booking document workflow. The hotel, room assignment and reservation are fictional; no stay has been purchased or confirmed. Special requests are illustrative only.',40,755,515,8.5,12);
  return page.finish(`SAMPLE ${city} hotel voucher - ${b.reference}`);
}

function serviceDocument(customer:DemoCustomer,service:'transfers'|'visas'|'extras'):Buffer {
  const b=customer.booking;
  const title={transfers:'Transfer arrangements',visas:'Visa service summary',extras:'Package services overview'}[service];
  const page=introduction(customer,title,service);
  page.heading(service==='transfers'?'Illustrative ground transport':service==='visas'?'Demonstration service checklist':'Included sample arrangements',303);
  const madinahFirst=b.route.arrivalCode==='MED';
  const firstHotel=madinahFirst?b.madinahHotel:b.makkahHotel;
  const secondHotel=madinahFirst?b.makkahHotel:b.madinahHotel;
  const transferDate=madinahFirst?b.madinahCheckOut:b.makkahCheckOut;
  const lastHotel=b.route.returnOriginCode==='MED'?b.madinahHotel:b.makkahHotel;
  const rows=service==='transfers'?[
    ['Airport arrival',`${b.route.arrivalName} (${b.route.arrivalCode}) to ${firstHotel}`],
    ['Arrival collection',`${dateTime(addHours(b.arrivalAt,1))} / sample meeting point in arrivals`],
    ['Intercity transfer',`${date(transferDate)} / ${firstHotel} to ${secondHotel}`],
    ['Return airport',`${date(b.returnAt)} / ${lastHotel} to ${b.route.returnOriginName}`],
    ['Vehicle allocation',`${b.passengers.length<=3?'Private sedan':'Private minibus'} / ${b.passengers.length} sample passengers`],
  ]:service==='visas'?[
    ['Service type','Sample travel document assistance'],['Travel window',`${date(b.departureAt)} to ${date(b.returnAt)}`],
    ['Documents reviewed','Fictional identity references and demonstration passenger list'],['Authority decision','None - this is not a visa, permit, or government document'],
    ['Submission status','No application has been submitted to any authority'],
  ]:[
    ['Travel package',b.packageName],['Flights',`${b.route.originCode} to ${b.route.arrivalCode}; return from ${b.route.returnOriginCode}`],
    ['Accommodation',`${b.makkahNights} nights Makkah + ${b.madinahNights} nights Madinah`],
    ['Room arrangement',`${b.roomType} for ${b.passengers.length} travellers`],
    ['Package value',`${money(b.totalMinor)} - demonstration accounting amount`],
  ];
  let y=321;
  rows.forEach(([label,value],index)=>{
    const lines=wrap(value,10,350);
    const height=Math.max(38,lines.length*14+17);
    if(index%2===0) page.rect(40,y,515,height);
    page.text(label,51,y+22,9,true,colors.muted,132);
    page.block(value,195,y+22,345,10,14,colors.ink);
    y+=height;
  });
  passengerTable(page,customer,Math.max(583,y+24));
  page.block('Sample data only. No supplier has been paid and no travel, immigration or transportation service has been ordered. All arrangements shown here exist solely to exercise the LedgerBook demonstration workspace.',40,755,515,8.5,12);
  return page.finish(`SAMPLE ${title.toLowerCase()} - ${b.reference}`);
}

export function buildDemoDocuments(customer:DemoCustomer):DemoDocument[] {
  const requested=new Set<DemoServiceKey>(['flight',...customer.booking.requiredServices]);
  return Array.from(requested).map(serviceKey=>({serviceKey,
    name:`SAMPLE-${customer.booking.reference}-${serviceKey}.pdf`,
    content:serviceKey==='flight'?flightDocument(customer):serviceKey==='makkah'||serviceKey==='madinah'?hotelDocument(customer,serviceKey):serviceDocument(customer,serviceKey),
  }));
}

function xml(value:unknown) {return String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]!));}
export async function receiptImage(customer:DemoCustomer,payment:DemoPayment,receiptIndex=0):Promise<Buffer> {
  if(!Number.isInteger(receiptIndex) || receiptIndex<0 || receiptIndex>4) throw new Error('Use a receipt index between zero and four.');
  const status={approved:'APPROVED DEMO RECORD',pending:'PENDING ADMIN REVIEW',rejected:'REJECTED DEMO RECORD'}[payment.status];
  const statusColor={approved:'#24796a',pending:'#88650e',rejected:'#a13d3d'}[payment.status];
  const fields=[['CUSTOMER',customer.name],['BOOKING',customer.booking.reference],['PAYMENT REFERENCE',payment.reference],
    ['PAYMENT DATE',date(payment.paymentDate)],['SUBMITTED',dateTime(payment.submittedAt)],
    ['METHOD','Simulated bank transfer'],['BENEFICIARY','Sample Horizon Journeys (fictional)']];
  const rows=fields.map(([label,value],index)=>{
    const top=470+index*77;
    return `<text x="82" y="${top}" font-size="14" fill="#63747b" letter-spacing="1">${xml(label)}</text><text x="82" y="${top+29}" font-size="23" font-weight="600" fill="#102f3c">${xml(value)}</text><path d="M82 ${top+46}H918" stroke="#dce5e7"/>`;
  }).join('');
  const noteLines=wrap(payment.note||'Demonstration payment evidence for manual review.',20,820).slice(0,3);
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1370" viewBox="0 0 1000 1370">
    <rect width="1000" height="1370" fill="#edf3f4"/><rect x="40" y="36" width="920" height="1296" rx="24" fill="#fff"/>
    <path d="M64 36H936Q960 36 960 60V212H40V60Q40 36 64 36" fill="#102f3c"/>
    <g font-family="Arial, Helvetica, sans-serif"><text x="82" y="87" font-size="15" fill="#b8d8d1" letter-spacing="2">LEDGERBOOK / DEMONSTRATION EVIDENCE</text>
    <text x="82" y="137" font-size="32" font-weight="700" fill="#fff">Sample Horizon Journeys</text>
    <text x="82" y="176" font-size="19" fill="#dbe9e7">${receiptIndex===0?'Customer payment record':'Supporting payment detail'} / image ${receiptIndex+1}</text>
    <rect x="40" y="212" width="920" height="58" fill="#fff0c2"/><text x="82" y="249" font-size="23" font-weight="700" fill="#654900">TEST PAYMENT / NO MONEY MOVED</text>
    <text x="82" y="325" font-size="16" fill="#63747b" letter-spacing="1">ILLUSTRATIVE AMOUNT</text>
    <text x="82" y="384" font-size="48" font-weight="700" fill="#102f3c">${xml(money(payment.amountMinor))}</text>
    <text x="82" y="420" font-size="16" font-weight="700" fill="${statusColor}">${xml(status)}</text>
    ${rows}<text x="82" y="1039" font-size="14" fill="#63747b" letter-spacing="1">CUSTOMER NOTE</text>
    ${noteLines.map((line,index)=>`<text x="82" y="${1070+index*27}" font-size="20" fill="#102f3c">${xml(line)}</text>`).join('')}
    <rect x="66" y="1180" width="868" height="116" rx="12" fill="#f2f6f7"/>
    <text x="82" y="1213" font-size="19" font-weight="700" fill="#102f3c">SAMPLE ONLY - NOT PROOF OF A REAL PAYMENT</text>
    <text x="82" y="1243" font-size="17" fill="#5c6b72">No bank, card processor or payment provider created this image.</text>
    <text x="82" y="1270" font-size="17" fill="#5c6b72">Fictional data for testing uploads, reviews and ledger posting.</text></g></svg>`;
  return sharp(Buffer.from(svg)).webp({lossless:true,effort:4}).toBuffer();
}
