import { createHash } from 'node:crypto';

/** Entirely synthetic fixtures. No identity, itinerary, document or payment is real. */
export const DEMO_AS_OF = '2026-11-06';
export const DEMO_ORGANIZATION_NAME = 'LedgerBook Demo — Autumn 2026';
export const DEMO_NOTICE = 'FICTIONAL DEMO DATA — not a real customer, reservation, travel document or payment.';

/** RFC 4122 UUIDv5, using the URL namespace and a versioned fixture name. */
export function seedUUID(key: string): string {
  const namespace = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
  const bytes = createHash('sha1').update(namespace).update(`ledgerbook/demo/autumn-2026/v1/${key}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export const DEMO_ORGANIZATION_ID = seedUUID('organization');

export type DemoScenario = 'fully_paid' | 'partial' | 'deposit_pending' | 'unpaid';
export type DemoService = 'flight' | 'makkah' | 'madinah' | 'transfers' | 'visas' | 'extras';
export type DemoServiceKey = DemoService;
export type DemoPassenger = {
  id: string;
  name: string;
  category: 'adult' | 'child';
  age: number;
  documentReference: string;
};
export type DemoPayment = {
  id: string;
  idempotencyKey: string;
  status: 'approved' | 'pending' | 'rejected';
  amountMinor: string;
  paymentDate: string;
  submittedAt: string;
  reviewedAt: string | null;
  reference: string;
  note: string;
  rejectionReason: string | null;
  receiptCount: number;
};
export type DemoBooking = {
  id: string;
  idempotencyKey: string;
  reference: string;
  currency: 'GBP';
  totalMinor: string;
  bookedOn: string;
  createdAt: string;
  departureAt: string;
  arrivalAt: string;
  returnAt: string;
  returnArrivalAt: string;
  route: {
    originCode: string;
    originName: string;
    arrivalCode: 'JED' | 'MED';
    arrivalName: string;
    returnOriginCode: 'JED' | 'MED';
    returnOriginName: string;
    viaCode: 'DOH' | 'IST' | null;
  };
  airline: string;
  flightNumbers: { outbound: string; return: string };
  passengers: DemoPassenger[];
  makkahNights: number;
  madinahNights: number;
  makkahHotel: string;
  madinahHotel: string;
  makkahCheckIn: string;
  makkahCheckOut: string;
  madinahCheckIn: string;
  madinahCheckOut: string;
  roomType: string;
  roomCount: number;
  packageName: string;
  requiredServices: DemoService[];
  issuedServices: DemoService[];
  instalments: { id: string; dueDate: string; amountMinor: string }[];
  payments: DemoPayment[];
};
export type DemoCustomer = {
  id: string;
  userId: string;
  membershipId: string;
  idempotencyKey: string;
  name: string;
  email: string;
  phone: string;
  createdAt: string;
  notes: string;
  scenario: DemoScenario;
  booking: DemoBooking;
};

// Each party is written out deliberately: family groups, couples, friends and solo
// travellers have different ages, room needs, lead times and payment histories.
// The last column is the illustrative adult package price in whole GBP.
type PartySeed = readonly [createdOn: string, departureOn: string, makkahNights: number, madinahNights: number, passengers: string, adultPrice: number];
const parties: readonly PartySeed[] = [
  ['2026-09-01', '2026-09-20', 7, 5, 'Amina Farooq:42|Imran Farooq:45|Yusuf Farooq:13|Hana Farooq:9', 1095],
  ['2026-09-03', '2026-09-24', 6, 4, 'Omar Siddiqui:34|Maryam Siddiqui:31', 1245],
  ['2026-09-05', '2026-09-29', 8, 6, 'Safiya Hussain:63|Rashid Hussain:67', 1495],
  ['2026-09-07', '2026-10-01', 7, 5, 'Bilal Qureshi:28', 1195],
  ['2026-09-09', '2026-10-04', 8, 5, 'Nadia Rahman:39|Tariq Rahman:42|Zara Rahman:11|Adam Rahman:7', 1145],
  ['2026-09-11', '2026-10-08', 6, 4, 'Faisal Malik:46|Samina Malik:43|Hamza Malik:18', 1295],
  ['2026-09-14', '2026-10-11', 10, 6, 'Hafsa Ahmed:57|Javed Ahmed:61|Saira Ahmed:29|Usman Ahmed:32', 1545],
  ['2026-09-17', '2026-10-14', 7, 5, 'Ibrahim Khan:35|Zain Ali:34|Haroon Abbas:36', 1095],
  ['2026-09-20', '2026-10-18', 8, 6, 'Sumayya Patel:40|Ilyas Patel:44|Aisha Patel:16|Idris Patel:12|Lina Patel:8', 1195],
  ['2026-09-23', '2026-10-22', 6, 4, 'Adil Mahmood:53|Nasreen Mahmood:50', 1395],
  ['2026-09-26', '2026-10-26', 7, 5, 'Zainab Begum:66|Salma Begum:62|Rukhsana Begum:59', 1495],
  ['2026-09-29', '2026-10-29', 8, 6, 'Yasir Mirza:38|Huda Mirza:35|Rehan Mirza:10', 1245],
  ['2026-10-02', '2026-11-02', 8, 5, 'Mariam Iqbal:33|Saad Iqbal:36', 1595],
  ['2026-10-05', '2026-11-06', 6, 4, 'Nabeel Akhtar:48|Lubna Akhtar:45|Daniyal Akhtar:20|Areeba Akhtar:17', 1345],
  ['2026-10-08', '2026-11-10', 7, 5, 'Sana Yousaf:27', 1295],
  ['2026-10-11', '2026-11-14', 8, 6, 'Khalid Bashir:70|Farida Bashir:64', 1695],
  ['2026-10-15', '2026-11-18', 10, 6, 'Rubina Aslam:47|Sohail Aslam:51|Mehreen Aslam:22|Shahid Aslam:25|Amir Aslam:15|Noor Aslam:10', 1395],
  ['2026-10-20', '2026-11-23', 6, 4, 'Rafiq Choudhury:44|Nusrat Choudhury:41', 1195],
  ['2026-10-24', '2026-11-28', 7, 5, 'Aleena Saeed:30|Faizan Saeed:32|Musa Saeed:5', 1245],
  ['2026-10-28', '2026-12-03', 8, 6, 'Adeel Ansari:55|Shazia Ansari:52|Hassan Ansari:24', 1445],
  ['2026-09-08', '2026-11-11', 7, 5, 'Farhan Aziz:37|Iqra Aziz:34|Eesa Aziz:8|Inaya Aziz:5', 1095],
  ['2026-09-15', '2026-11-13', 8, 6, 'Tasneem Shah:58|Waseem Shah:62', 1495],
  ['2026-09-22', '2026-11-15', 6, 4, 'Kamran Sheikh:41|Bushra Sheikh:38|Ammar Sheikh:14', 1195],
  ['2026-09-30', '2026-11-18', 7, 5, 'Naila Rauf:36|Sadia Rauf:33|Humaira Rauf:39', 1245],
  ['2026-10-06', '2026-11-21', 8, 5, 'Dawood Munir:49|Fauzia Munir:46|Zainab Munir:21|Talha Munir:18', 1395],
  ['2026-10-12', '2026-11-23', 7, 5, 'Rabia Latif:28|Ahsan Latif:31', 1295],
  ['2026-10-17', '2026-11-25', 10, 6, 'Junaid Saleem:43|Saba Saleem:40|Owais Saleem:16|Alina Saleem:12|Ismail Saleem:9', 1345],
  ['2026-10-21', '2026-11-28', 8, 6, 'Fariha Nadeem:61|Shahid Nadeem:65', 1595],
  ['2026-10-25', '2026-12-01', 6, 4, 'Aqib Zaman:26', 1095],
  ['2026-10-29', '2026-12-03', 7, 5, 'Hina Sadiq:32|Shahbaz Sadiq:35|Aya Sadiq:6', 1195],
  ['2026-10-31', '2026-12-05', 8, 6, 'Salman Ashraf:45|Nazia Ashraf:42|Ali Ashraf:19|Maha Ashraf:15', 1445],
  ['2026-11-01', '2026-12-08', 7, 5, 'Uzma Hafeez:54|Naeem Hafeez:57', 1395],
  ['2026-11-02', '2026-12-10', 6, 4, 'Zubair Hanif:39|Shayan Hanif:36|Rehan Hanif:34', 1145],
  ['2026-11-03', '2026-12-13', 8, 5, 'Asma Javed:37|Waqar Javed:41|Ayaan Javed:11|Amal Javed:7', 1245],
  ['2026-11-04', '2026-12-15', 10, 6, 'Arif Younis:64|Tahira Younis:60', 1695],
  ['2026-10-03', '2026-11-20', 7, 5, 'Hamid Kazmi:50|Shabana Kazmi:47|Abbas Kazmi:23', 1295],
  ['2026-10-09', '2026-11-24', 8, 6, 'Noreen Chaudhry:44|Majid Chaudhry:48|Sara Chaudhry:17|Rayyan Chaudhry:13', 1345],
  ['2026-10-16', '2026-11-29', 6, 4, 'Arsalan Naeem:29|Sidra Naeem:27', 1195],
  ['2026-10-22', '2026-12-04', 7, 5, 'Rizwana Anwar:56|Iqbal Anwar:61', 1545],
  ['2026-10-27', '2026-12-09', 8, 5, 'Shuaib Hassan:35|Saman Hassan:32|Yahya Hassan:8', 1245],
  ['2026-10-30', '2026-12-12', 10, 6, 'Mehwish Zafar:40|Noman Zafar:43|Mariam Zafar:15|Rayan Zafar:11|Aiza Zafar:6', 1395],
  ['2026-11-01', '2026-12-16', 8, 6, 'Wajid Tariq:33|Saqib Tariq:31', 1295],
  ['2026-11-03', '2026-12-19', 7, 5, 'Sadia Majeed:48|Mansoor Majeed:52|Eman Majeed:22', 1445],
  ['2026-11-04', '2026-12-22', 6, 4, 'Tahir Rasheed:59|Parveen Rasheed:55', 1495],
  ['2026-11-05', '2026-12-25', 8, 6, 'Ayesha Khalil:31|Fahad Khalil:34|Ibrahim Khalil:7|Safiya Khalil:4', 1345],
  ['2026-10-26', '2026-11-22', 7, 5, 'Imtiaz Saifi:46|Shireen Saifi:43', 1245],
  ['2026-11-02', '2026-11-30', 8, 6, 'Saira Murtaza:34|Younus Murtaza:38|Hadi Murtaza:10', 1195],
  ['2026-11-04', '2026-12-07', 6, 4, 'Naeema Akram:62|Abdul Akram:67', 1595],
  ['2026-11-05', '2026-12-12', 7, 5, 'Kashif Jalal:30|Sameer Jalal:28|Adnan Jalal:32', 1095],
  ['2026-11-06', '2026-12-18', 8, 5, 'Huma Shafiq:41|Wasim Shafiq:45|Nimra Shafiq:16|Zoya Shafiq:9', 1295],
];

function addDays(date: string, days: number): string {
  const result = new Date(`${date}T12:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}
function earlier(a: string, b: string) { return a < b ? a : b; }
function later(a: string, b: string) { return a > b ? a : b; }
function percentage(amount: bigint, percent: number): bigint { return amount * BigInt(percent) / 100n; }

const airports = [
  { code: 'LHR', name: 'London Heathrow' },
  { code: 'MAN', name: 'Manchester' },
  { code: 'BHX', name: 'Birmingham' },
  { code: 'LGW', name: 'London Gatwick' },
  { code: 'EDI', name: 'Edinburgh' },
  { code: 'GLA', name: 'Glasgow' },
] as const;
const makkahHotels = ['Sample Safa Courtyard Hotel', 'Sample Noor Terrace Hotel', 'Sample Hilal Garden Residence', 'Sample Amanah Heights Hotel', 'Sample Mina Lantern Suites'];
const madinahHotels = ['Sample Palm Lantern Hotel', 'Sample Taiba Courtyard Residence', 'Sample Sakinah Garden Hotel', 'Sample Olive Crescent Suites', 'Sample Rawdah Terrace Hotel'];

function paymentHistory(index: number, scenario: DemoScenario, total: bigint, bookedOn: string, departureOn: string): DemoPayment[] {
  const key = `customer-${index + 1}`;
  const serial = String(index + 1).padStart(3, '0');
  const result: DemoPayment[] = [];
  function add(status: DemoPayment['status'], amount: bigint, paymentDate: string, note: string, rejectionReason: string | null = null) {
    const ordinal = result.length + 1;
    // All times are UTC; a same-day review always follows its submission.
    const minute = [10, 30, 45][ordinal - 1];
    result.push({
      id: seedUUID(`${key}/payment-${ordinal}`), idempotencyKey: seedUUID(`${key}/payment-${ordinal}/request`),
      status, amountMinor: amount.toString(), paymentDate,
      submittedAt: `${paymentDate}T09:${minute}:00.000Z`,
      reviewedAt: status === 'pending' ? null : `${paymentDate}T09:${minute + 8}:00.000Z`,
      reference: `SAMPLE-TRANSFER-${serial}-${String(ordinal).padStart(2, '0')}`,
      note: `${note} Fictional demonstration transfer; no money was sent.`,
      rejectionReason, receiptCount: ordinal === 1 && index % 3 === 0 ? 2 : 1,
    });
  }
  const deposit = percentage(total, 25);
  const nextPaymentOn = earlier(addDays(bookedOn, 9 + index % 8), DEMO_AS_OF);
  if (scenario === 'fully_paid') {
    if (index % 4 === 0) {
      add('approved', total, earlier(addDays(bookedOn, 1), DEMO_AS_OF), 'Full package balance received in one transfer.');
    } else {
      add('approved', deposit, bookedOn, 'Booking deposit received.');
      const finalOn = earlier(later(addDays(bookedOn, 2), addDays(departureOn, -21)), DEMO_AS_OF);
      if (index % 3 === 0) {
        const middle = percentage(total, 25);
        add('approved', middle, earlier(nextPaymentOn, finalOn), 'Second scheduled instalment received.');
        add('approved', total - deposit - middle, finalOn, 'Final balance verified before travel.');
      } else add('approved', total - deposit, finalOn, 'Remaining package balance verified.');
    }
  } else if (scenario === 'partial') {
    const credited = percentage(total, 40 + index % 4 * 10);
    add('approved', deposit, bookedOn, 'Initial booking deposit verified.');
    add('approved', credited - deposit, nextPaymentOn, 'Part payment toward the remaining package balance.');
    if (index % 5 === 0) add('pending', percentage(total, 10), earlier(addDays(nextPaymentOn, 2), DEMO_AS_OF), 'Additional instalment submitted; administrator verification is pending.');
    else if (index % 5 === 2) add('rejected', percentage(total, 10), earlier(addDays(nextPaymentOn, 1), DEMO_AS_OF), 'Customer uploaded an incomplete transfer image.', 'The screenshot does not show a completed transfer. Please upload the final bank confirmation.');
  } else if (scenario === 'deposit_pending') {
    if (index < 40) {
      add('approved', deposit, bookedOn, 'Initial deposit confirmed; next instalment awaits review.');
      add('pending', deposit, nextPaymentOn, 'Second instalment receipt uploaded for manual approval.');
    } else {
      add('pending', deposit, earlier(addDays(bookedOn, 1), DEMO_AS_OF), 'First deposit receipt awaiting manual verification.');
      if (index === 42) add('rejected', percentage(total, 10), bookedOn, 'An earlier incomplete screenshot was not accepted.', 'Please provide the completed transaction screen with its amount and reference.');
    }
  } else if (index === 45 || index === 47) {
    add('rejected', deposit, earlier(addDays(bookedOn, 1), DEMO_AS_OF), 'Transfer was prepared but the evidence did not confirm completion.', 'The image shows a transfer draft, not a successful payment. Please submit confirmation after payment.');
  }
  return result.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.id.localeCompare(b.id));
}

function makeCustomer(party: PartySeed, index: number): DemoCustomer {
  const [createdOn, departureOn, makkahNights, madinahNights, partyText, adultPrice] = party;
  const serial = String(index + 1).padStart(3, '0');
  const key = `customer-${index + 1}`;
  const scenario: DemoScenario = index < 20 ? 'fully_paid' : index < 35 ? 'partial' : index < 45 ? 'deposit_pending' : 'unpaid';
  const passengers: DemoPassenger[] = partyText.split('|').map((entry, passengerIndex) => {
    const [name, ageText] = entry.split(':');
    const age = Number(ageText);
    return { id: seedUUID(`${key}/passenger-${passengerIndex + 1}`), name, age,
      category: age < 12 ? 'child' : 'adult', documentReference: `SAMPLE-PAX-${serial}-${String(passengerIndex + 1).padStart(2, '0')}` };
  });
  const name = passengers[0].name;
  const adultMinor = BigInt(adultPrice) * 100n;
  const total = passengers.reduce((sum, passenger) => sum + (passenger.category === 'child' ? adultMinor * 4n / 5n : adultMinor), 0n)
    + (passengers.length === 1 ? 22500n : 0n);
  const bookedOn = earlier(addDays(createdOn, index % 3), DEMO_AS_OF);
  const createdAt = `${createdOn}T08:${String(5 + index % 50).padStart(2, '0')}:00.000Z`;
  const bookingCreatedAt = `${bookedOn}T09:00:00.000Z`;
  const arrivalOn = addDays(departureOn, 1);
  const returnOn = addDays(arrivalOn, makkahNights + madinahNights);
  const madinahFirst = index % 4 === 1;
  const makkahCheckIn = madinahFirst ? addDays(arrivalOn, madinahNights) : arrivalOn;
  const madinahCheckIn = madinahFirst ? arrivalOn : addDays(arrivalOn, makkahNights);
  const airport = airports[index % airports.length];
  const viaCode = airport.code === 'EDI' ? 'DOH' : airport.code === 'GLA' ? 'IST' : index % 7 === 0 ? 'DOH' : null;
  const requiredServices: DemoService[] = ['flight', 'makkah', 'madinah', 'transfers', 'visas'];
  let issuedServices: DemoService[];
  if (departureOn <= DEMO_AS_OF) issuedServices = [...requiredServices];
  else if (scenario === 'fully_paid') issuedServices = departureOn <= addDays(DEMO_AS_OF, 14) ? [...requiredServices] : ['flight', 'makkah', 'madinah'];
  else if (scenario === 'partial') issuedServices = departureOn <= addDays(DEMO_AS_OF, 14) ? ['flight', 'makkah', 'madinah', 'transfers'] : ['flight', ...(index % 2 === 0 ? ['makkah' as const, 'madinah' as const] : [])];
  else if (scenario === 'deposit_pending' && index < 40) issuedServices = index % 2 === 0 ? ['flight'] : ['makkah', 'madinah'];
  else issuedServices = [];
  const deposit = percentage(total, 25);
  const middle = percentage(total, 25);
  const secondDue = later(bookedOn, addDays(departureOn, -28));
  const finalDue = later(secondDue, addDays(departureOn, -14));
  const children = passengers.filter(passenger => passenger.category === 'child').length;
  const seniors = passengers.filter(passenger => passenger.age >= 60).length;
  const familyNote = children ? `${children} child traveller${children === 1 ? '' : 's'}; family room arrangement requested.`
    : seniors ? `${seniors} senior traveller${seniors === 1 ? '' : 's'}; lower-floor room preference where available.`
      : passengers.length === 1 ? 'Solo traveller; single-room supplement included.' : 'Travellers prefer rooms on the same floor where available.';
  return {
    id: seedUUID(key), userId: seedUUID(`${key}/user`), membershipId: seedUUID(`${key}/membership`), idempotencyKey: seedUUID(`${key}/request`),
    name, email: `demo.${name.toLowerCase().replaceAll(' ', '.')}.${serial}@example.test`,
    // Ofcom's reserved UK drama mobile range 07700 900000–900999.
    phone: `+44 7700 900${String(100 + index).padStart(3, '0')}`,
    createdAt, notes: `${DEMO_NOTICE} ${familyNote}`, scenario,
    booking: {
      id: seedUUID(`${key}/booking`), idempotencyKey: seedUUID(`${key}/booking/request`),
      reference: `DEMO-UMR-26-${serial}`, currency: 'GBP', totalMinor: total.toString(), bookedOn, createdAt: bookingCreatedAt,
      departureAt: `${departureOn}T18:30:00.000Z`, arrivalAt: `${arrivalOn}T${viaCode ? '08' : '01'}:30:00.000Z`,
      returnAt: `${returnOn}T10:30:00.000Z`, returnArrivalAt: `${returnOn}T${viaCode ? '23' : '18'}:00:00.000Z`,
      route: { originCode: airport.code, originName: airport.name,
        arrivalCode: madinahFirst ? 'MED' : 'JED', arrivalName: madinahFirst ? 'Madinah Prince Mohammad bin Abdulaziz' : 'Jeddah King Abdulaziz',
        returnOriginCode: madinahFirst ? 'JED' : 'MED', returnOriginName: madinahFirst ? 'Jeddah King Abdulaziz' : 'Madinah Prince Mohammad bin Abdulaziz', viaCode },
      airline: viaCode ? 'Sample Meridian Airways (fictional)' : 'Sample Crescent Air (fictional)',
      flightNumbers: { outbound: `SAMPLE-OUT-${serial}`, return: `SAMPLE-RET-${serial}` },
      passengers, makkahNights, madinahNights, makkahHotel: makkahHotels[index % makkahHotels.length], madinahHotel: madinahHotels[(index + 2) % madinahHotels.length],
      makkahCheckIn, makkahCheckOut: addDays(makkahCheckIn, makkahNights), madinahCheckIn, madinahCheckOut: addDays(madinahCheckIn, madinahNights),
      roomType: ['Single room', 'Twin room', 'Triple room', 'Quad room', 'One twin and one triple room', 'Two triple rooms'][passengers.length - 1],
      roomCount: passengers.length > 4 ? 2 : 1,
      packageName: `${makkahNights + madinahNights}-night ${adultPrice >= 1495 ? 'Premier' : adultPrice >= 1245 ? 'Comfort' : 'Essential'} Umrah — sample itinerary`,
      requiredServices, issuedServices,
      instalments: [
        { id: seedUUID(`${key}/instalment-1`), dueDate: bookedOn, amountMinor: deposit.toString() },
        { id: seedUUID(`${key}/instalment-2`), dueDate: secondDue, amountMinor: middle.toString() },
        { id: seedUUID(`${key}/instalment-3`), dueDate: finalDue, amountMinor: (total - deposit - middle).toString() },
      ],
      payments: paymentHistory(index, scenario, total, bookedOn, departureOn),
    },
  };
}

export const demoCustomers: DemoCustomer[] = parties.map(makeCustomer);

/** Fail before seeding if an edited fixture stops being coherent. Pure; no I/O. */
export function validateDemoData(customers: readonly DemoCustomer[] = demoCustomers): void {
  function ensure(condition: boolean, message: string): asserts condition { if (!condition) throw new Error(`Invalid demo data: ${message}`); }
  ensure(customers.length === 50, 'expected exactly 50 customers');
  const ids = new Set<string>();
  const emails = new Set<string>();
  const references = new Set<string>();
  const counts: Record<DemoScenario, number> = { fully_paid: 0, partial: 0, deposit_pending: 0, unpaid: 0 };
  for (const customer of customers) {
    const booking = customer.booking;
    counts[customer.scenario]++;
    ensure(!ids.has(customer.id) && !emails.has(customer.email) && !references.has(booking.reference), 'duplicate customer or booking identity');
    ids.add(customer.id); emails.add(customer.email); references.add(booking.reference);
    ensure(customer.email.endsWith('@example.test') && customer.notes.includes(DEMO_NOTICE), `non-demo identity ${customer.id}`);
    ensure(customer.createdAt.slice(0, 10) >= '2026-09-01' && customer.createdAt.slice(0, 10) <= DEMO_AS_OF, 'account creation outside demo period');
    ensure(customer.createdAt <= booking.createdAt && booking.createdAt.slice(0, 10) === booking.bookedOn && booking.bookedOn <= DEMO_AS_OF, 'booking predates account or is future dated');
    ensure(booking.bookedOn < booking.departureAt.slice(0, 10) && booking.departureAt < booking.arrivalAt && booking.arrivalAt < booking.returnAt && booking.returnAt < booking.returnArrivalAt, 'invalid flight chronology');
    const nights = booking.makkahNights + booking.madinahNights;
    ensure(nights >= 10 && nights <= 16, 'hotel nights outside 10–16');
    ensure(addDays(booking.makkahCheckIn, booking.makkahNights) === booking.makkahCheckOut && addDays(booking.madinahCheckIn, booking.madinahNights) === booking.madinahCheckOut, 'hotel nights disagree with dates');
    ensure(earlier(booking.makkahCheckIn, booking.madinahCheckIn) === booking.arrivalAt.slice(0, 10) && later(booking.makkahCheckOut, booking.madinahCheckOut) === booking.returnAt.slice(0, 10), 'hotel dates do not cover stay');
    ensure(booking.makkahCheckOut === booking.madinahCheckIn || booking.madinahCheckOut === booking.makkahCheckIn, 'hotel stays overlap or have a gap');
    const total = BigInt(booking.totalMinor);
    ensure(total > 0n && booking.instalments.reduce((sum, item) => sum + BigInt(item.amountMinor), 0n) === total, 'instalments do not equal booking total');
    ensure(booking.instalments.every(item => BigInt(item.amountMinor) > 0n && item.dueDate >= booking.bookedOn && item.dueDate < booking.departureAt.slice(0, 10)), 'invalid instalment');
    let approved = 0n;
    let pending = 0n;
    for (const payment of booking.payments) {
      ensure(BigInt(payment.amountMinor) > 0n && payment.paymentDate >= booking.bookedOn && payment.paymentDate <= DEMO_AS_OF, 'invalid payment amount/date');
      ensure(payment.submittedAt >= booking.createdAt && payment.submittedAt.slice(0, 10) >= payment.paymentDate && payment.submittedAt.slice(0, 10) <= DEMO_AS_OF, 'invalid submission chronology');
      ensure(payment.submittedAt <= `${DEMO_AS_OF}T10:00:00.000Z` && (!payment.reviewedAt || payment.reviewedAt <= `${DEMO_AS_OF}T10:00:00.000Z`), 'payment is ahead of the demo snapshot');
      ensure(payment.status === 'pending' ? payment.reviewedAt === null : payment.reviewedAt !== null && payment.reviewedAt >= payment.submittedAt && payment.reviewedAt.slice(0, 10) <= DEMO_AS_OF, 'invalid review chronology');
      ensure(payment.status === 'rejected' ? !!payment.rejectionReason : payment.rejectionReason === null, 'invalid rejection state');
      if (payment.status === 'approved') approved += BigInt(payment.amountMinor);
      if (payment.status === 'pending') pending += BigInt(payment.amountMinor);
    }
    ensure(approved + pending <= total, 'approved and pending payments exceed booking total');
    ensure(customer.scenario !== 'fully_paid' || approved === total, 'fully paid scenario is not settled');
    ensure(customer.scenario !== 'partial' || approved > 0n && approved < total, 'partial scenario is not partially paid');
    ensure(customer.scenario !== 'deposit_pending' || pending > 0n && approved < total, 'deposit scenario has no pending receipt');
    ensure(customer.scenario !== 'unpaid' || approved === 0n && pending === 0n, 'unpaid scenario contains credited or pending funds');
    ensure(booking.departureAt.slice(0, 10) > DEMO_AS_OF || booking.requiredServices.every(service => booking.issuedServices.includes(service)), 'departed booking has missing required documents');
  }
  ensure(counts.fully_paid === 20 && counts.partial === 15 && counts.deposit_pending === 10 && counts.unpaid === 5, 'scenario distribution differs from 20/15/10/5');
}

validateDemoData();
