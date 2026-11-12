export const companyDirectory = [
  { slug: "muhabiya-hotels", name: "Muhabiya Hotels" },
  { slug: "aden-golden", name: "Aden Golden" },
  { slug: "al-subaee", name: "Al Subaee" },
] as const;

export type Company = {
  id: string;
  organization_id: string;
  company_name: string;
  hotel_name: string;
  customer_name: string;
  check_in: string | null;
  check_out: string | null;
  quantity: number;
  room_type: string;
  booking_date: string | null;
  voucher_number: string;
  voucher_price_minor: string | null;
  remarks: string;
  created_at: string;
  updated_at: string;
  version: number;
};

export type CompanyList = {
  items: Company[];
  total: number;
  page: number;
  page_size: number;
  currency: string;
  currency_exponent: number;
  totals: { total_minor: string | null; paid_minor: string; balance_minor: string | null; unpaid_minor: string | null; unpriced_count: number; voucher_count: number; paid_version: number | null };
};

export type CompanyExport = Omit<CompanyList, "page" | "page_size"> & { company_name: string };

export const companyDateFields = [
  { value: "booking_date", label: "Booking date" },
  { value: "check_in", label: "Check-in" },
  { value: "check_out", label: "Check-out" },
] as const;

export type CompanyDateField = typeof companyDateFields[number]["value"];

export const companyMoneyFields = [
  { name: "voucher_price", label: "Voucher total", minor: "voucher_price_minor" },
] as const;

export type CompanyFields = {
  company_name: string;
  hotel_name: string;
  customer_name: string;
  check_in: string;
  check_out: string;
  quantity: string;
  room_type: string;
  booking_date: string;
  voucher_number: string;
  voucher_price: string;
  remarks: string;
};

// Keep every digit when opening an amount for editing, including large values.
export function companyDecimal(value: string | null | undefined, exponent: number): string {
  if (value === null || value === undefined) return "";
  const minor = BigInt(value);
  const absolute = minor < 0n ? -minor : minor;
  const scale = 10n ** BigInt(exponent);
  return `${minor < 0n ? "-" : ""}${absolute / scale}${exponent ? `.${(absolute % scale).toString().padStart(exponent, "0")}` : ""}`;
}

export function companyFields(company: Company | undefined, exponent: number): CompanyFields {
  return {
    company_name: company?.company_name || "",
    hotel_name: company?.hotel_name || "",
    customer_name: company?.customer_name || "",
    check_in: company?.check_in || "",
    check_out: company?.check_out || "",
    quantity: String(company?.quantity ?? 1),
    room_type: company?.room_type || "",
    booking_date: company?.booking_date || "",
    voucher_number: company?.voucher_number || "",
    voucher_price: companyDecimal(company?.voucher_price_minor, exponent),
    remarks: company?.remarks || "",
  };
}

function dateValue(value: string, label: string) {
  if (!value) return null;
  const date = new Date(`${value}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    throw new Error(`${label} must be a valid date.`);
  if (value < "1900-01-01") throw new Error(`${label} must be on or after 1 January 1900.`);
  return value;
}

function amountValue(value: string, label: string, exponent: number, signed: boolean) {
  const input = value.trim();
  if (!input) return null;
  const match = /^(?<sign>-?)(?<whole>\d{1,18})(?:\.(?<fraction>\d{1,3}))?$/.exec(input);
  if (!match?.groups || (!signed && match.groups.sign === "-") || (match.groups.fraction || "").length > exponent)
    throw new Error(`${label} must be ${signed ? "an amount" : "zero or a positive amount"}${exponent ? ` with at most ${exponent} decimal places` : " with no decimal places"}.`);
  const absolute = BigInt(match.groups.whole) * (10n ** BigInt(exponent)) + BigInt((match.groups.fraction || "").padEnd(exponent, "0") || "0");
  if (absolute > 100000000000000n) throw new Error(`${label} is too large.`);
  return input;
}

export function companyPaidPayload(value: string, exponent: number): string {
  const input = value.trim();
  const match = /^(\d{1,27})(?:\.(\d{1,3}))?$/.exec(input);
  if (!match || ![0, 2, 3].includes(exponent) || (match[2] || "").length > exponent)
    throw new Error(`Enter a nonnegative paid amount${exponent ? ` with up to ${exponent} decimal places` : " in whole units"}.`);
  return input;
}

export function companyPayload(fields: CompanyFields, exponent: number) {
  const companyName = fields.company_name.trim();
  if (!companyName) throw new Error("Enter a company name.");
  const textFields = [
    ["Company name", companyName, 200], ["Hotel name", fields.hotel_name.trim(), 200],
    ["Customer name", fields.customer_name.trim(), 200], ["Room type", fields.room_type.trim(), 200],
    ["Voucher number", fields.voucher_number.trim(), 100], ["Remarks", fields.remarks.trim(), 2000],
  ] as const;
  for (const [label, value, limit] of textFields) {
    if (value.length > limit) throw new Error(`${label} must be ${limit} characters or fewer.`);
  }
  const checkIn = dateValue(fields.check_in, "Check-in");
  const checkOut = dateValue(fields.check_out, "Check-out");
  if (checkIn && checkOut && checkIn > checkOut) throw new Error("Check-out must be on or after check-in.");
  if (!/^\d+$/.test(fields.quantity) || Number(fields.quantity) < 1 || Number(fields.quantity) > 1000000)
    throw new Error("Quantity must be a whole number between 1 and 1,000,000.");
  return {
    company_name: companyName,
    hotel_name: fields.hotel_name.trim(),
    customer_name: fields.customer_name.trim(),
    check_in: checkIn,
    check_out: checkOut,
    quantity: Number(fields.quantity),
    room_type: fields.room_type.trim(),
    booking_date: dateValue(fields.booking_date, "Booking date"),
    voucher_number: fields.voucher_number.trim(),
    voucher_price: amountValue(fields.voucher_price, "Voucher total", exponent, false),
    remarks: fields.remarks.trim(),
  };
}
