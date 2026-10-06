import { createHash } from 'node:crypto';
import { newId } from './db.js';
import { CONFIG } from './config.js';

export const hashKey = (k) => createHash('sha256').update(k).digest('hex');

const WINDOWS = {
  'Very Early Morning': '05:00', 'Early Morning': '07:00', 'Late Morning': '10:30', Afternoon: '14:00',
  'Late Afternoon': '16:30', Evening: '19:00', 'Late Night': '22:00'
};

// [origin, originCity, dest, destCity, minutes, window, aircraft, seats, category, priceUSD, dayOffset, altAircraft, flags]
const LEGS = [
  ['LAS', 'Las Vegas', 'ASE', 'Aspen', 63, 'Late Morning', 'Hawker 900XP', 8, 'Midsize jet', 5753, 1, 0],
  ['BNA', 'Nashville', 'DJT', 'West Palm Beach', 92, 'Afternoon', 'Gulfstream 550', 18, 'Ultra long range jet', 14159, 1, 2],
  ['LAS', 'Las Vegas', 'SLC', 'Salt Lake City', 43, 'Late Afternoon', 'Citation XLS', 8, 'Midsize jet', 4500, 1, 0],
  ['DAL', 'Dallas', 'BFL', 'Bakersfield', 190, 'Evening', 'Learjet 60', 7, 'Midsize jet', 11889, 1, 0],
  ['BFI', 'Seattle', 'SAC', 'Sacramento', 94, 'Evening', 'Learjet 45', 8, 'Light jet', 7069, 1, 0],
  ['VNY', 'Van Nuys', 'LAS', 'Las Vegas', 31, 'Late Night', 'Learjet 60', 7, 'Midsize jet', 4500, 1, 0],
  ['LAS', 'Las Vegas', 'TVL', 'South Lake Tahoe', 38, 'Early Morning', 'Learjet 60', 7, 'Midsize jet', 4050, 2, 0],
  ['LAS', 'Las Vegas', 'OAK', 'Oakland', 50, 'Early Morning', 'Hawker 900XP', 8, 'Midsize jet', 4302, 2, 0],
  ['LAS', 'Las Vegas', 'RNO', 'Reno', 40, 'Late Morning', 'Challenger 850', 15, 'Heavy jet', 7695, 2, 1],
  ['LAS', 'Las Vegas', 'SNA', 'Santa Ana', 37, 'Late Morning', 'Challenger 850', 15, 'Heavy jet', 7695, 2, 2],
  ['LAS', 'Las Vegas', 'VNY', 'Van Nuys', 37, 'Afternoon', 'Hawker 900XP', 8, 'Midsize jet', 4050, 2, 0],
  ['SAN', 'San Diego', 'LAS', 'Las Vegas', 35, 'Late Afternoon', 'Challenger 850', 15, 'Heavy jet', 7695, 2, 1],
  ['CMA', 'Camarillo', 'LAS', 'Las Vegas', 34, 'Late Afternoon', 'Learjet 45', 8, 'Light jet', 4500, 2, 0],
  ['SDF', 'Louisville', 'ADS', 'Dallas', 102, 'Evening', 'Challenger 850', 19, 'Heavy jet', 10530, 2, 0],
  ['SLC', 'Salt Lake City', 'LAS', 'Las Vegas', 44, 'Evening', 'Learjet 45', 8, 'Light jet', 4050, 2, 0],
  // Per-seat, members-only shared flights: not financeable (not a charter of a whole aircraft).
  ['LAS', 'Las Vegas', 'VNY', 'Van Nuys', 55, 'Afternoon', null, null, null, 1250, 3, 0, { perSeat: 1, memberOnly: 1 }],
  ['VNY', 'Van Nuys', 'LAS', 'Las Vegas', 41, 'Late Afternoon', null, null, null, 1250, 3, 0, { perSeat: 1, memberOnly: 1 }],
  ['BFL', 'Bakersfield', 'LAS', 'Las Vegas', 30, 'Very Early Morning', 'Learjet 60', 7, 'Midsize jet', 4500, 3, 0]
];

export const DEMO_PARTNER_KEY = 'demo_partner_key';
export const demoOperatorKey = (i) => `demo_operator_key_${i}`; // i = 1..3

export function seed(db, now = new Date()) {
  const stamp = now.toISOString();
  db.prepare('INSERT INTO partners (id,name,api_key_hash,fee_adjust_bps,max_loan_cents,active,allowed_origins,created_at) VALUES (?,?,?,?,?,1,?,?)')
    .run('ptr_demo', 'Demo Charter Marketplace', hashKey(DEMO_PARTNER_KEY), 0, CONFIG.maxLoanCents, 'http://localhost:3000,http://127.0.0.1:3000', stamp);

  // Demo operators only. Real Part 135 certificates must be verified against FAA records before cert_verified=1.
  const ops = ['Demo Air Charter A', 'Demo Jet Services B', 'Demo Aviation C'].map((name, i) => {
    const id = `op_demo${i + 1}`;
    db.prepare('INSERT INTO operators (id,name,part135_cert,cert_verified,active,commission_bps,api_key_hash) VALUES (?,?,?,1,1,?,?)')
      .run(id, name, `DEMO-135-00${i + 1}`, CONFIG.operatorCommissionBps, hashKey(demoOperatorKey(i + 1)));
    return id;
  });

  const ins = db.prepare(`INSERT INTO legs (id,operator_id,origin_code,origin_city,dest_code,dest_city,duration_min,departs_at,
    time_window,aircraft,seats,category,price_cents,operator_price_cents,markup_bps,per_seat,member_only,alt_aircraft) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  LEGS.forEach((l, i) => {
    const [o, oc, d, dc, min, win, ac, seats, cat, price, off, alt, f = {}] = l;
    const dep = new Date(now);
    dep.setUTCDate(dep.getUTCDate() + off);
    const [h, m] = WINDOWS[win].split(':').map(Number);
    dep.setUTCHours(h, m, 0, 0);
    ins.run(newId('leg'), ops[i % ops.length], o, oc, d, dc, min, dep.toISOString(), win, ac, seats, cat,
      price * 100, Math.round(price * 100 * (1 - CONFIG.operatorCommissionBps / 10000)), 0, f.perSeat || 0, f.memberOnly || 0, alt);
  });
}
