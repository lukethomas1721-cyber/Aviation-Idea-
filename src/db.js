import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS partners (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, api_key_hash TEXT NOT NULL UNIQUE,
  fee_bps INTEGER NOT NULL, max_loan_cents INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS operators (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, part135_cert TEXT NOT NULL,
  cert_verified INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS legs (
  id TEXT PRIMARY KEY, operator_id TEXT NOT NULL REFERENCES operators(id),
  origin_code TEXT NOT NULL, origin_city TEXT NOT NULL, dest_code TEXT NOT NULL, dest_city TEXT NOT NULL,
  duration_min INTEGER NOT NULL, departs_at TEXT NOT NULL, time_window TEXT NOT NULL,
  aircraft TEXT, seats INTEGER, category TEXT, price_cents INTEGER NOT NULL,
  per_seat INTEGER NOT NULL DEFAULT 0, member_only INTEGER NOT NULL DEFAULT 0, alt_aircraft INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'available');
CREATE TABLE IF NOT EXISTS borrowers (
  id TEXT PRIMARY KEY, legal_name TEXT NOT NULL, entity_type TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  annual_revenue_cents INTEGER NOT NULL, years_in_business REAL NOT NULL, credit_score INTEGER NOT NULL,
  kyc_passed INTEGER NOT NULL, ofac_clear INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS loans (
  id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id), leg_id TEXT NOT NULL REFERENCES legs(id),
  borrower_id TEXT NOT NULL REFERENCES borrowers(id), status TEXT NOT NULL,
  charter_price_cents INTEGER NOT NULL, down_payment_cents INTEGER NOT NULL, principal_cents INTEGER NOT NULL,
  fee_bps INTEGER NOT NULL, fee_cents INTEGER NOT NULL, total_cents INTEGER NOT NULL, apr REAL NOT NULL,
  installments INTEGER NOT NULL, interval_days INTEGER NOT NULL,
  decision TEXT NOT NULL, decision_reasons TEXT NOT NULL, risk_tier TEXT,
  review_note TEXT, signed_by TEXT,
  created_at TEXT NOT NULL, expires_at TEXT, funded_at TEXT, closed_at TEXT);
CREATE INDEX IF NOT EXISTS loans_status ON loans(status);
CREATE INDEX IF NOT EXISTS loans_borrower ON loans(borrower_id);
CREATE TABLE IF NOT EXISTS installments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, loan_id TEXT NOT NULL REFERENCES loans(id), seq INTEGER NOT NULL,
  due_date TEXT NOT NULL, amount_cents INTEGER NOT NULL, principal_cents INTEGER NOT NULL, fee_cents INTEGER NOT NULL,
  paid_cents INTEGER NOT NULL DEFAULT 0, paid_at TEXT, UNIQUE(loan_id, seq));
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY, loan_id TEXT NOT NULL REFERENCES loans(id), amount_cents INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(loan_id, idempotency_key));
CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY, loan_id TEXT NOT NULL REFERENCES loans(id), operator_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL, status TEXT NOT NULL, reference TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, loan_id TEXT, type TEXT NOT NULL, data TEXT, created_at TEXT NOT NULL);
`;

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const newId = (prefix) => `${prefix}_${randomBytes(8).toString('hex')}`;
