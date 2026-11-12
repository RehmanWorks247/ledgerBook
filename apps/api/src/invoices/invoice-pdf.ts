import PDFDocument from 'pdfkit';
import { brotliDecompressSync } from 'node:zlib';
import { formatMoney } from '../ledger/money';
import bundledFont from './invoice-font.json';
import styleFonts from './invoice-style-fonts.json';
import brand from './invoice-brand.json';
import type { InvoiceSnapshot } from './invoice.types';

// JSON assets are copied by tsc, so rendering needs no host fonts or network.
const unpackFont = (value: string) => brotliDecompressSync(Buffer.from(value, 'base64'));
const font = unpackFont(bundledFont.font_brotli_base64);
const regularFont = unpackFont(styleFonts.regular.font_brotli_base64);
const boldFont = unpackFont(styleFonts.bold.font_brotli_base64);
const logo = Buffer.from(brand.logo_png_base64, 'base64');
const codepoints = (ranges: number[][]) => {
  const points = new Set<number>();
  for (const [first, last] of ranges) {
    for (let point = first; point <= last; point++) points.add(point);
  }
  return points;
};
const regularPoints = codepoints(styleFonts.regular.codepoint_ranges);
const boldPoints = codepoints(styleFonts.bold.codepoint_ranges);
// Every preserved character must also exist in the fallback font. A mixed-script
// line can select it even when some of its characters exist only in Poppins.
const supported = codepoints(bundledFont.codepoint_ranges);

/** Preserve unsupported characters explicitly instead of silently losing a name. */
export function invoiceText(value: string): string {
  return [...value.normalize('NFC')].map(character => {
    const point = character.codePointAt(0)!;
    if (point < 32 || (point >= 127 && point <= 159)) return ' ';
    // Bidi control characters can make an identifier read as a different value.
    if ((point >= 0x202a && point <= 0x202e) || (point >= 0x2066 && point <= 0x2069)) return '';
    return supported.has(point) ? character : `[U+${point.toString(16).toUpperCase()}]`;
  }).join('');
}

const services: Record<string, string> = {
  flight: 'Flight Tickets', makkah: 'Makkah Hotel', madinah: 'Madinah Hotel', transfers: 'Transfers', visas: 'Visas', extras: 'Extras',
};
const gold = '#d8ad46';
const charcoal = '#2a2a28';
const ink = '#111111';

/** The supplied black-and-gold payment invoice, populated only with saved facts. */
export function renderInvoicePdf(snapshot: InvoiceSnapshot): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4', margin: 0, bufferPages: true, compress: true,
      info: {
        Title: `Invoice ${snapshot.invoice_number}`, Author: brand.company_name,
        Subject: `Booking ${snapshot.booking.reference}`, Creator: 'Ledgerbook',
        CreationDate: new Date(snapshot.issued_at), ModDate: new Date(snapshot.issued_at),
      },
    });
    const chunks: Buffer[] = [];
    let size = 0;
    doc.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) doc.destroy(new Error('Generated invoice exceeds the supported PDF size.'));
      else chunks.push(chunk);
    });
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    try {
      doc.registerFont('Invoice', font).registerFont('Poppins', regularFont).registerFont('PoppinsBold', boldFont);
      const left = 50;
      const bodyWidth = doc.page.width - left * 2;
      const bodyBottom = doc.page.height - 74;
      let pageNumber = 1;
      const fontFor = (value: string, bold: boolean) => [...value].every(character =>
        (bold ? boldPoints : regularPoints).has(character.codePointAt(0)!)) ? (bold ? 'PoppinsBold' : 'Poppins') : 'Invoice';
      const measure = (value: string, width: number, fontSize = 11, bold = false) => {
        const clean = invoiceText(value);
        doc.font(fontFor(clean, bold)).fontSize(fontSize);
        return doc.heightOfString(clean, { width, lineGap: 1 });
      };
      const text = (value: string, x: number, y: number, width: number, fontSize = 11, bold = false, color = ink,
        align: 'left' | 'right' = 'left') => {
        const clean = invoiceText(value);
        doc.font(fontFor(clean, bold)).fontSize(fontSize).fillColor(color)
          .text(clean, x, y, { width, lineGap: 1, align });
        return doc.y;
      };
      const polygon = (color: string, points: [number, number][]) => {
        doc.moveTo(...points[0]);
        for (const point of points.slice(1)) doc.lineTo(...point);
        doc.closePath().fill(color);
      };
      const date = (value: string) => new Intl.DateTimeFormat('en-GB', {
        day: '2-digit', month: 'long', year: 'numeric', timeZone: snapshot.time_zone,
      }).format(new Date(value)).replaceAll(' ', '-');
      // Keep minor-unit arithmetic exact, including balances beyond JS's safe integer range.
      const money = (value: string) => `${snapshot.currency === 'GBP' ? '£' : `${snapshot.currency} `}${formatMoney(value, 2)}`;
      const stationery = () => {
        const w = doc.page.width;
        const h = doc.page.height;
        doc.rect(0, 0, w, 33).fill(charcoal);
        polygon(gold, [[264, 0], [w, 0], [w, 50.5], [308, 50.5]]);
        doc.rect(0, h - 17, w, 17).fill(charcoal);
        polygon(gold, [[0, h - 34], [300, h - 34], [330, h], [0, h]]);
        text('Payment Invoice', 316, 5, w - 328, 15.5, true, ink, 'right');
        text(`Date:${date(snapshot.issued_at)}`, 316, 26, w - 328, 13.5, true, ink, 'right');
      };
      const newPage = () => { doc.addPage(); pageNumber++; stationery(); return 78; };
      const fitText = (value: string, width: number, fontSize: number, height: number): [string, string] => {
        const clean = invoiceText(value);
        if (measure(clean, width, fontSize) <= height) return [clean, ''];
        const characters = [...clean];
        let low = 1;
        let high = characters.length;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (measure(characters.slice(0, middle).join(''), width, fontSize) <= height) low = middle;
          else high = middle - 1;
        }
        // Prefer a word boundary, but also handle long identifiers without spaces.
        const space = characters.slice(0, low).lastIndexOf(' ');
        let end = space > low * 0.7 ? space : low;
        const prefix = characters.slice(0, end).join('');
        const escapeStart = prefix.lastIndexOf('[');
        if (escapeStart > 0 && prefix.lastIndexOf(']') < escapeStart &&
          /^\[U\+[0-9A-F]+\]/.test(characters.slice(escapeStart).join(''))) end = escapeStart;
        return [characters.slice(0, end).join(''), characters.slice(end).join('').trimStart()];
      };
      const field = (label: string, value: string, y: number, fontSize = 11.5) => {
        const x = left + 9;
        const labelWidth = doc.font('PoppinsBold').fontSize(fontSize).widthOfString(`${label} `) + 2;
        let remaining = value;
        do {
          if (y + 25 > bodyBottom) y = newPage();
          const [part, rest] = fitText(remaining, bodyWidth - labelWidth - 18, fontSize, bodyBottom - y - 3);
          text(label, x, y, labelWidth, fontSize, true);
          y = Math.max(y + 19, text(part, x + labelWidth, y, bodyWidth - labelWidth - 18, fontSize) + 2);
          remaining = rest;
          if (remaining) y = newPage();
        } while (remaining);
        return y;
      };
      const tableHeader = (y: number, width: number, split: number, secondLabel: string, height = 27, angledEnd = false) => {
        polygon(charcoal, [[left, y], [left + split, y], [left + split - 24, y + height], [left, y + height]]);
        polygon(gold, [[left + split + 8, y], [left + width, y], [left + width - (angledEnd ? 24 : 0), y + height], [left + split - 16, y + height]]);
        text('Description', left + 12, y + 5, split - 36, 10.5, false, '#ffffff');
        text(secondLabel, left + split + (angledEnd ? 7 : 16), y + 5, width - split - 12, 10.5, false, '#ffffff');
      };

      stationery();
      doc.image(logo, left + 9, 58, { width: 154 });
      text(brand.company_name, left + 9, 140, bodyWidth - 18, 16, true);
      doc.rect(left + 9, 169, 191, 1.5).fill(gold);
      let y = field('Address:', brand.address, 180, 11.5);
      y = field('Contact No:', brand.phone, y, 11.5);
      field('Email:', brand.email, y, 12);
      doc.rect(left + 9, 248, bodyWidth - 30, 5).fill(gold);

      text('Bill to:', left + 9, 263, bodyWidth - 18, 15.3, true);
      y = field('Guest Name:', snapshot.customer.name, 287, 11.8);
      if (snapshot.customer.phone?.trim()) y = field('Contact number:', snapshot.customer.phone, y, 11.8);
      if (snapshot.customer.email.trim()) y = field('Email:', snapshot.customer.email, y, 11.8);

      // The booking model has service categories, not passenger/room quantities.
      // Keep the reference's two-column table without manufacturing those values.
      const rows = [
        ['Booking reference', snapshot.booking.reference],
        ['Departure', date(snapshot.booking.departure_at)],
      ];
      if (snapshot.status === 'cancelled') rows.push(['Booking status', snapshot.booking.cancelled_at ? 'Cancelled' : 'Charge reversed']);
      y = Math.max(pageNumber === 1 ? 371 : 78, y + 17);
      if (y + 75 > bodyBottom) y = newPage();
      const split = 272;
      const detailsX = left + split - 8;
      const detailsWidth = bodyWidth - split;
      tableHeader(y, bodyWidth, split, 'Details');
      y += 36;
      for (const [label, value] of rows) {
        let remaining = value;
        do {
          if (y + 30 > bodyBottom) { y = newPage(); tableHeader(y, bodyWidth, split, 'Details'); y += 36; }
          const [part, rest] = fitText(remaining, detailsWidth, 10.65, bodyBottom - y - 10);
          text(label, left + 9, y, split - 30, 10.65, false, charcoal);
          text(part, detailsX, y, detailsWidth, 10.65, false, charcoal);
          y += Math.max(26, measure(part, detailsWidth, 10.65) + 10);
          remaining = rest;
        } while (remaining);
      }

      // Follow the booking form's order and print only its selected services.
      // Vector checkboxes stay sharp in print and do not depend on font glyphs.
      const includedServices = Object.entries(services)
        .filter(([key]) => snapshot.booking.required_services.includes(key))
        .map(([, label]) => label);
      if (includedServices.length) {
        const panelHeight = 32 + Math.ceil(includedServices.length / 2) * 24;
        y += 12;
        if (y + panelHeight > bodyBottom) y = newPage();
        doc.roundedRect(left, y, bodyWidth, panelHeight, 5).fill('#faf7ef');
        text('Included services', left + 14, y + 9, bodyWidth - 28, 10, true, charcoal);
        const columnWidth = (bodyWidth - 28) / 2;
        includedServices.forEach((label, index) => {
          const x = left + 14 + (index % 2) * columnWidth;
          const rowY = y + 32 + Math.floor(index / 2) * 24;
          doc.save();
          doc.roundedRect(x, rowY + 1, 12, 12, 2).lineWidth(0.9).fillAndStroke('#ffffff', gold);
          doc.moveTo(x + 2.8, rowY + 7).lineTo(x + 5.2, rowY + 9.3).lineTo(x + 9.4, rowY + 4.3)
            .lineWidth(1.35).lineCap('round').lineJoin('round').stroke(charcoal);
          doc.restore();
          text(label, x + 21, rowY - 1, columnWidth - 29, 10.5, false, charcoal);
        });
        y += panelHeight + 22;
      } else {
        y += 28;
      }
      if (y + 139 > bodyBottom) y = newPage();
      text('Payment Details:', left + 2, y, bodyWidth, 16.6, true);
      y += 29;
      const balance = BigInt(snapshot.balance_minor);
      const totals = [
        ['Total Amount', money(snapshot.total_minor)],
        ['Received Amount', money(snapshot.paid_minor)],
        [balance < 0n ? 'Credit Amount' : 'Balance Amount', money((balance < 0n ? -balance : balance).toString())],
      ];
      const amountWidth = Math.max(111, ...totals.map(([, amount]) =>
        doc.font('PoppinsBold').fontSize(11.5).widthOfString(invoiceText(amount)) + 18));
      const paymentWidth = Math.min(bodyWidth, 204 + amountWidth);
      tableHeader(y, paymentWidth - 57, 195, 'Amount', 25, true);
      y += 25;
      for (let index = 0; index < totals.length; index++) {
        const [label, amount] = totals[index];
        if (index === 1) doc.rect(left, y, paymentWidth, 25).fill('#f3f3f4');
        text(label, left + 10, y + 6, 179, 9.65, true, charcoal);
        text(amount, left + 204, y + 4, paymentWidth - 210, 11.5, true, charcoal);
        y += 25;
      }

      // Keep a usable invoice identifier without printing internal audit/version notes.
      const range = doc.bufferedPageRange();
      for (let index = range.start; index < range.start + range.count; index++) {
        doc.switchToPage(index);
        text(snapshot.invoice_number, left, doc.page.height - 57, bodyWidth - 70, 7, false, '#666666');
        if (range.count > 1) text(`${index + 1} / ${range.count}`, doc.page.width - left - 60,
          doc.page.height - 57, 60, 8, false, '#666666', 'right');
      }
      doc.end();
    } catch (error) {
      doc.destroy();
      reject(error);
    }
  });
}
