export const bookingServices = [
  { key: "flight", label: "Flight Tickets" },
  { key: "makkah", label: "Makkah Hotel" },
  { key: "madinah", label: "Madinah Hotel" },
  { key: "transfers", label: "Transfers" },
  { key: "visas", label: "Visas" },
  { key: "extras", label: "Extras" },
] as const;

function dateParts(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

export function businessDate(timeZone: string, now = new Date()) {
  return dateParts(now, timeZone).slice(0, 10);
}

export function departureInstant(localDateTime: string, timeZone: string) {
  const target = Date.parse(`${localDateTime}:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(localDateTime) || !Number.isFinite(target) || new Date(target).toISOString().slice(0, 16) !== localDateTime)
    throw new Error("Enter a valid departure date and time.");
  let guess = target;
  for (let attempt = 0; attempt < 4; attempt++) {
    const represented = Date.parse(`${dateParts(new Date(guess), timeZone)}:00Z`);
    const difference = target - represented;
    if (difference === 0) return new Date(guess).toISOString();
    guess += difference;
  }
  throw new Error("This departure time does not exist in the business time zone. Choose another time.");
}

export function departureLabel(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone, dateStyle: "medium", timeStyle: "short",
  }).format(new Date(value));
}

export type BookingFilters = { search: string; start: string; end: string; service: string };

type SearchableBooking = {
  id: string; reference: string; customer_id: string; customer_code?: string;
  departure_at: string; required_services: string[]; total_minor: string;
};

export function filterBookings<T extends SearchableBooking>(bookings: T[], filters: BookingFilters, timeZone: string): T[] {
  if (filters.start && filters.end && filters.start > filters.end) return [];
  const terms = filters.search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return bookings.filter(booking => {
    const date = businessDate(timeZone, new Date(booking.departure_at));
    if ((filters.start && date < filters.start) || (filters.end && date > filters.end)) return false;
    if (filters.service && !booking.required_services.includes(filters.service)) return false;
    const amount = BigInt(booking.total_minor);
    const fraction = String(amount % 100n).padStart(2, "0");
    const plainAmount = `${amount / 100n}.${fraction}`;
    const formattedAmount = `${(amount / 100n).toLocaleString("en-GB")}.${fraction}`;
    const searchable = [booking.id, booking.reference, booking.customer_id, booking.customer_code,
      date, departureLabel(booking.departure_at, timeZone), plainAmount, formattedAmount, `£${plainAmount}`, `£${formattedAmount}`, "GBP",
      ...bookingServices.filter(service => booking.required_services.includes(service.key)).map(service => service.label),
    ].join(" ").toLocaleLowerCase();
    return terms.every(term => searchable.includes(term));
  });
}
