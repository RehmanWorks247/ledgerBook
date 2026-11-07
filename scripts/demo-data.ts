import { createHash } from 'node:crypto';

/** Entirely synthetic fixtures. No identity, itinerary, document or payment is real. */
export const DEMO_START_DATE = '2026-08-07';
export const DEMO_AS_OF = '2026-11-06';
export const DEMO_CUSTOMER_COUNT = 200;
export const DEMO_FIXTURE_VERSION = 'rolling-2026-11-200-v1';
export const DEMO_ORGANIZATION_NAME = 'LedgerBook Demo — 200 Customers, Aug–Nov 2026';
export const DEMO_NOTICE = 'FICTIONAL DEMO DATA — not a real customer, reservation, travel document or payment.';

/** RFC 4122 UUIDv5, using the URL namespace and a versioned fixture name. */
export function seedUUID(key: string): string {
  const namespace = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
  const bytes = createHash('sha1').update(namespace).update(`ledgerbook/demo/${DEMO_FIXTURE_VERSION}/${key}`).digest().subarray(0, 16);
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

// Fictional names assembled from curated name pools, never copied from customer
// records. Two distinct lead names per surname give 200 distinct households.
// Family, senior, friend and solo groups have age-appropriate room requirements.
type PartySeed = readonly [createdOn: string, departureOn: string, makkahNights: number, madinahNights: number, passengers: string, adultPrice: number];
const surnames = [
  'Farooq', 'Siddiqui', 'Hussain', 'Qureshi', 'Rahman', 'Malik', 'Ahmed', 'Khan', 'Patel', 'Mahmood',
  'Begum', 'Mirza', 'Iqbal', 'Akhtar', 'Yousaf', 'Bashir', 'Aslam', 'Choudhury', 'Saeed', 'Ansari',
  'Aziz', 'Shah', 'Sheikh', 'Rauf', 'Munir', 'Latif', 'Saleem', 'Nadeem', 'Zaman', 'Sadiq',
  'Ashraf', 'Hafeez', 'Hanif', 'Javed', 'Younis', 'Kazmi', 'Chaudhry', 'Naeem', 'Anwar', 'Hassan',
  'Zafar', 'Tariq', 'Majeed', 'Rasheed', 'Khalil', 'Saifi', 'Murtaza', 'Akram', 'Jalal', 'Shafiq',
  'Abbasi', 'Alvi', 'Baig', 'Butt', 'Dar', 'Ghauri', 'Hashmi', 'Jafri', 'Lodhi', 'Masood',
  'Nizami', 'Osmani', 'Qadri', 'Rizvi', 'Sattar', 'Usmani', 'Warsi', 'Zaidi', 'Chishti', 'Durrani',
  'Faruqi', 'Gilani', 'Haider', 'Ismail', 'Jilani', 'Khatri', 'Lakhani', 'Memon', 'Navid', 'Pandor',
  'Rangrez', 'Surti', 'Vohra', 'Bham', 'Desai', 'Dudhia', 'Gani', 'Kolia', 'Mulla', 'Rawat',
  'Aden', 'Elmi', 'Hersi', 'Warsame', 'Abdi', 'Alami', 'Mansouri', 'Nasser', 'Salim', 'Zaki',
] as const;
const femaleNames = [
  'Amina', 'Maryam', 'Safiya', 'Nadia', 'Hafsa', 'Sumayya', 'Zainab', 'Mariam', 'Sana', 'Rubina',
  'Aleena', 'Iqra', 'Tasneem', 'Naila', 'Rabia', 'Fariha', 'Hina', 'Uzma', 'Asma', 'Noreen',
  'Rizwana', 'Mehwish', 'Sadia', 'Ayesha', 'Saira', 'Naeema', 'Huma', 'Farhana', 'Samira', 'Laila',
  'Yasmin', 'Aaliyah', 'Amira', 'Safa', 'Rania', 'Suhana', 'Nabila', 'Farah', 'Nazia', 'Tahmina',
  'Bushra', 'Shazia', 'Parveen', 'Tahira', 'Lubna', 'Nusrat', 'Shabana', 'Shireen', 'Fauzia', 'Nasreen',
  'Nimra', 'Zoya', 'Inaya', 'Hana', 'Zara', 'Amal', 'Noor', 'Eman', 'Maha', 'Aiza',
  'Ruqayya', 'Huda', 'Salma', 'Sakinah', 'Iman', 'Safaa', 'Hodan', 'Ifrah', 'Nawal', 'Khadija',
] as const;
const maleNames = [
  'Imran', 'Omar', 'Rashid', 'Bilal', 'Tariq', 'Faisal', 'Javed', 'Ibrahim', 'Ilyas', 'Adil',
  'Yasir', 'Saad', 'Nabeel', 'Khalid', 'Sohail', 'Rafiq', 'Faizan', 'Adeel', 'Farhan', 'Waseem',
  'Kamran', 'Dawood', 'Ahsan', 'Junaid', 'Aqib', 'Salman', 'Zubair', 'Arif', 'Hamid', 'Arsalan',
  'Shuaib', 'Wajid', 'Tahir', 'Imtiaz', 'Kashif', 'Fahad', 'Hamza', 'Usman', 'Haroon', 'Idris',
  'Rehan', 'Talha', 'Ammar', 'Yusuf', 'Hassan', 'Musa', 'Zain', 'Ismail', 'Rayyan', 'Daniyal',
  'Abbas', 'Hadi', 'Yahya', 'Owais', 'Naeem', 'Majid', 'Mansoor', 'Waqar', 'Shahid', 'Noman',
  'Eesa', 'Ayaan', 'Mikail', 'Sufyan', 'Abdirahman', 'Hamdi', 'Yasin', 'Anas', 'Karim', 'Taha',
] as const;

function scenarioFor(index: number): DemoScenario {
  // A coprime permutation distributes the payment states across the entire
  // history instead of making one calendar month exclusively unpaid or settled.
  const bucket = index * 37 % DEMO_CUSTOMER_COUNT;
  return bucket < 90 ? 'fully_paid' : bucket < 150 ? 'partial' : bucket < 180 ? 'deposit_pending' : 'unpaid';
}

function makeParty(index: number): PartySeed {
  const family = Math.floor(index / 2);
  const surname = surnames[family];
  const femaleLead = index % 2 === 0;
  const firstName = femaleLead ? femaleNames[family % femaleNames.length] : maleNames[family % maleNames.length];
  const partnerName = femaleLead ? maleNames[(family + 11) % maleNames.length] : femaleNames[(family + 17) % femaleNames.length];
  const pattern = (index * 7 + Math.floor(index / 10)) % 10;
  let leadAge = 29 + index * 13 % 25;
  if (pattern === 4) leadAge = 61 + index % 13;
  if (pattern === 2 || pattern === 3) leadAge = 33 + index % 12;
  if (pattern === 6) leadAge = 40 + index % 11;
  if (pattern === 7) leadAge = 47 + index % 10;
  if (pattern === 8) leadAge = 39 + index % 9;
  const group = [`${firstName} ${surname}:${leadAge}`];
  const partner = () => group.push(`${partnerName} ${surname}:${leadAge + (femaleLead ? 3 : -2)}`);
  const child = (ordinal: number, age: number) => {
    const pool = (index + ordinal) % 2 === 0 ? femaleNames : maleNames;
    group.push(`${pool[(family + 35 + ordinal * 9) % pool.length]} ${surname}:${age}`);
  };
  if ([1, 2, 3, 4, 6, 7, 8, 9].includes(pattern)) partner();
  if (pattern === 2) child(1, 4 + index % 7);
  if (pattern === 3) { child(1, 10 + index % 5); child(2, 5 + index % 4); }
  if (pattern === 5) {
    group.push(`${maleNames[(family + 23) % maleNames.length]} ${surnames[(family + 29) % surnames.length]}:${leadAge + 2}`);
    group.push(`${maleNames[(family + 31) % maleNames.length]} ${surnames[(family + 43) % surnames.length]}:${leadAge - 1}`);
  }
  if (pattern === 6) { child(1, 17 + index % 3); child(2, 12 + index % 3); child(3, 6 + index % 4); }
  if (pattern === 7) { child(1, 20 + index % 4); child(2, 14 + index % 4); }
  if (pattern === 8) {
    group.push(`${femaleNames[(family + 26) % femaleNames.length]} ${surname}:${leadAge + 27}`);
    group.push(`${maleNames[(family + 30) % maleNames.length]} ${surname}:${leadAge - 6}`);
    child(1, 9 + index % 4); child(2, 5 + index % 3);
  }
  // 92 days inclusive, with two or three new households on almost every day.
  const createdOn = addDays(DEMO_START_DATE, Math.floor(index * 91 / (DEMO_CUSTOMER_COUNT - 1)));
  const scenario = scenarioFor(index);
  const departureOn = scenario === 'fully_paid' ? addDays(createdOn, 19 + index * 11 % 51)
    : later(addDays(createdOn, 42 + index * 7 % 58), addDays(DEMO_AS_OF, 8 + index * 13 % 54));
  const lengths = [[6, 4], [7, 5], [8, 6], [8, 5], [10, 6]] as const;
  const [makkahNights, madinahNights] = lengths[(index * 3 + family) % lengths.length];
  const adultPrice = [1095, 1145, 1195, 1245, 1295, 1345, 1395, 1445, 1495, 1595, 1695][(index * 7 + family) % 11];
  return [createdOn, departureOn, makkahNights, madinahNights, group.join('|'), adultPrice];
}

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
    // Booking creation is at 09:00 UTC. Every same-day submission and review
    // follows it, and sequential payments retain a valid order on a shared date.
    const minute = 4 + ordinal * 9 + index % 4;
    result.push({
      id: seedUUID(`${key}/payment-${ordinal}`), idempotencyKey: seedUUID(`${key}/payment-${ordinal}/request`),
      status, amountMinor: amount.toString(), paymentDate,
      submittedAt: `${paymentDate}T09:${String(minute).padStart(2, '0')}:00.000Z`,
      reviewedAt: status === 'pending' ? null : `${paymentDate}T09:${String(minute + 5).padStart(2, '0')}:00.000Z`,
      reference: `SAMPLE-TRANSFER-${serial}-${String(ordinal).padStart(2, '0')}`,
      note: `${note} Fictional demonstration transfer; no money was sent.`,
      rejectionReason, receiptCount: ordinal === 1 && index % 3 === 0 ? 2 : 1,
    });
  }
  const deposit = percentage(total, 25);
  const nextPaymentOn = earlier(addDays(bookedOn, 9 + index % 18), DEMO_AS_OF);
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
    if (index % 5 === 0) {
      const pendingOn = later(nextPaymentOn, addDays(DEMO_AS_OF, -(index % 3)));
      add('pending', percentage(total, 10), pendingOn, 'Additional instalment submitted; administrator verification is pending.');
    } else if (index % 5 === 2) {
      add('rejected', percentage(total, 10), earlier(addDays(nextPaymentOn, 1), DEMO_AS_OF), 'Customer uploaded an incomplete transfer image.', 'The screenshot does not show a completed transfer. Please upload the final bank confirmation.');
    }
  } else if (scenario === 'deposit_pending') {
    if (bookedOn <= addDays(DEMO_AS_OF, -7)) {
      add('approved', deposit, bookedOn, 'Initial deposit confirmed; next instalment awaits review.');
      add('pending', deposit, later(bookedOn, addDays(DEMO_AS_OF, -(index % 4))), 'Second instalment receipt uploaded for manual approval.');
    } else {
      if (index % 3 === 0) add('rejected', deposit, bookedOn, 'An earlier incomplete screenshot was not accepted.', 'Please provide the completed transaction screen with its amount and reference.');
      add('pending', deposit, earlier(addDays(bookedOn, 1), DEMO_AS_OF), 'First deposit receipt awaiting manual verification.');
    }
  } else if (index % 3 !== 1) {
    add('rejected', deposit, earlier(addDays(bookedOn, 1), DEMO_AS_OF), 'Transfer was prepared but the evidence did not confirm completion.', 'The image shows a transfer draft, not a successful payment. Please submit confirmation after payment.');
  }
  return result.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.id.localeCompare(b.id));
}

function makeCustomer(party: PartySeed, index: number): DemoCustomer {
  const [createdOn, departureOn, makkahNights, madinahNights, partyText, adultPrice] = party;
  const serial = String(index + 1).padStart(3, '0');
  const key = `customer-${index + 1}`;
  const scenario = scenarioFor(index);
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
  else if (scenario === 'deposit_pending' && bookedOn <= addDays(DEMO_AS_OF, -7)) issuedServices = index % 2 === 0 ? ['flight'] : ['makkah', 'madinah'];
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
    name, email: `demo200.${name.toLowerCase().replaceAll(' ', '.')}.${serial}@example.test`,
    // Ofcom's reserved UK drama mobile range 07700 900000–900999.
    phone: `+44 7700 900${String(300 + index).padStart(3, '0')}`,
    createdAt, notes: `${DEMO_NOTICE} ${familyNote} ${['Airport pickup requested for the whole party.', 'Prefers afternoon contact after work.', 'Printed copies of the itinerary requested.', 'Travellers will check baggage allowance before packing.', 'Wheelchair assistance to be confirmed if needed.', 'Prefers a quieter room away from the lifts.', 'First Umrah trip; pre-departure briefing requested.', 'Returning travellers; flexible on airline timings.', 'Connecting rooms preferred where available.', 'Will collect final travel pack at the office.'][index % 10]} ${scenario === 'unpaid' ? 'Provisional itinerary only; deposit follow-up outstanding.' : scenario === 'partial' ? 'Balance reminder to follow the agreed instalment dates.' : scenario === 'deposit_pending' ? 'New receipt is in the review queue.' : 'Package balance settled.'}`, scenario,
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

export const demoCustomers: DemoCustomer[] = Array.from({ length: DEMO_CUSTOMER_COUNT }, (_, index) => makeCustomer(makeParty(index), index));

/** Fail before seeding if an edited fixture stops being coherent. Pure; no I/O. */
export function validateDemoData(customers: readonly DemoCustomer[] = demoCustomers): void {
  function ensure(condition: boolean, message: string): asserts condition { if (!condition) throw new Error(`Invalid demo data: ${message}`); }
  ensure(customers.length === DEMO_CUSTOMER_COUNT, `expected exactly ${DEMO_CUSTOMER_COUNT} customers`);
  const ids = new Set<string>();
  const emails = new Set<string>();
  const names = new Set<string>();
  const phones = new Set<string>();
  const references = new Set<string>();
  const months = new Set<string>();
  const counts: Record<DemoScenario, number> = { fully_paid: 0, partial: 0, deposit_pending: 0, unpaid: 0 };
  for (const customer of customers) {
    const booking = customer.booking;
    counts[customer.scenario]++;
    ensure(!ids.has(customer.id) && !emails.has(customer.email) && !names.has(customer.name) && !phones.has(customer.phone) && !references.has(booking.reference), 'duplicate customer or booking identity');
    ids.add(customer.id); emails.add(customer.email); names.add(customer.name); phones.add(customer.phone); references.add(booking.reference);
    months.add(customer.createdAt.slice(0, 7));
    ensure(customer.email.startsWith('demo200.') && customer.email.endsWith('@example.test') && customer.notes.includes(DEMO_NOTICE), `non-demo identity ${customer.id}`);
    ensure(/^\+44 7700 900[3-4][0-9]{2}$/.test(customer.phone), 'phone outside the fixture reserved range');
    ensure(booking.passengers.length >= 1 && booking.passengers.length <= 6 && new Set(booking.passengers.map(passenger => passenger.name)).size === booking.passengers.length, 'invalid or duplicate passenger party');
    ensure(booking.passengers.every(passenger => passenger.age >= 4 && passenger.age <= 80 && (passenger.category === 'child') === (passenger.age < 12)), 'passenger age/category mismatch');
    ensure(customer.createdAt.slice(0, 10) >= DEMO_START_DATE && customer.createdAt.slice(0, 10) <= DEMO_AS_OF, 'account creation outside demo period');
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
    ensure(booking.departureAt.slice(0, 10) > DEMO_AS_OF || approved === total, 'departed booking has an unpaid balance');
    ensure(booking.departureAt.slice(0, 10) > DEMO_AS_OF || booking.requiredServices.every(service => booking.issuedServices.includes(service)), 'departed booking has missing required documents');
  }
  ensure([...months].sort().join(',') === '2026-08,2026-09,2026-10,2026-11', 'history does not cover the rolling three-month period');
  ensure(counts.fully_paid === 90 && counts.partial === 60 && counts.deposit_pending === 30 && counts.unpaid === 20, 'scenario distribution differs from 90/60/30/20');
}

validateDemoData();
