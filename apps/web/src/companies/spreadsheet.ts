import { companyDecimal, type CompanyExport } from "./model";

export type SheetCell = string | number | { amount: string };
export type CompanySheet = { name: string; headers: string[]; rows: SheetCell[][]; widths: number[] };

export function companySheets(data: CompanyExport): CompanySheet[] {
  const amount = (minor: string | null): SheetCell => minor === null ? "" : { amount: companyDecimal(minor, data.currency_exponent) };
  return [
    {
      name: "Records",
      headers: ["Company name", "Customer name", "Hotel name", "Check-in", "Check-out", "Quantity", "Room type", "Booking date", "Voucher number", "Voucher total (SAR)", "Remarks"],
      widths: [24, 28, 28, 15, 15, 12, 24, 15, 20, 24, 48],
      rows: data.items.map(row => [row.company_name, row.customer_name, row.hotel_name, row.check_in || "", row.check_out || "", row.quantity,
        row.room_type, row.booking_date || "", row.voucher_number, amount(row.voucher_price_minor), row.remarks]),
    },
    {
      name: "Summary", headers: ["Company summary", "Amount / details"], widths: [32, 76],
      rows: [
        ["Company", data.company_name], ["Currency", "SAR"], ["Voucher count", data.totals.voucher_count],
        ["Voucher total (SAR)", amount(data.totals.total_minor)], ["Total paid (SAR)", amount(data.totals.paid_minor)],
        ["Unpaid (SAR)", amount(data.totals.unpaid_minor)], ["Balance (SAR)", amount(data.totals.balance_minor)],
        ["Vouchers awaiting prices", data.totals.unpriced_count],
        ["Scope", "All company records, including records outside the current table filters."],
        ["Paid", "One shared paid amount for the company; not allocated to individual vouchers."],
        ["Quantity", "Informational only; each voucher price is its full total."],
        ["Blank amounts", "Unknown prices and totals awaiting prices are left blank."],
        ["Precision", "Amounts exceeding Excel's 15-digit precision are stored as exact text."],
      ],
    },
  ];
}

export function sheetCellText(cell: SheetCell): string {
  return typeof cell === "object" ? cell.amount : String(cell);
}

export function companyExportFilename(companyName: string): string {
  return `${companyName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "company"}-records.xlsx`;
}
