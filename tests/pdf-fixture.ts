import PDFDocument from 'pdfkit';

export function receiptPdf(title = 'Bank transfer receipt'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ size: 'A5', margin: 35 });
    const chunks: Buffer[] = [];
    document.on('data', chunk => chunks.push(Buffer.from(chunk)));
    document.on('error', reject);
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.fontSize(18).text(title);
    document.fontSize(12).text('Payment received: GBP 25.00');
    document.addPage().text('Bank confirmation details');
    document.end();
  });
}
