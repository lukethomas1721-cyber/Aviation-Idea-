import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS partners (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, api_key_hash TEXT NOT NULL UNIQUE,
  fee_adjust_bps INTEGER NOT NULL DEFAULT 0, max_loan_cents INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  allowed_origins TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS operators (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, part135_cert TEXT NOT NULL,
  cert_verified INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
  commission_bps INTEGER NOT NULL DEFAULT 0, api_key_hash TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS legs (
  id TEXT PRIMARY KEY, operator_id TEXT NOT NULL REFERENCES operators(id),
  origin_code TEXT NOT NULL, origin_city TEXT NOT NULL, dest_code TEXT NOT NULL, dest_city TEXT NOT NULL,
  duration_min INTEGER NOT NULL, departs_at TEXT NOT NULL, time_window TEXT NOT NULL,
  aircraft TEXT, seats INTEGER, category TEXT,
  price_cents INTEGER NOT NULL,           -- customer-facing price
  operator_price_cents INTEGER NOT NULL,  -- what the operator receives
  markup_bps INTEGER NOT NULL DEFAULT 0,  -- >0 = JetReserve marketplace listing (Plan B)
  leg_type TEXT NOT NULL DEFAULT 'empty_leg', -- empty_leg | charter
  per_seat INTEGER NOT NULL DEFAULT 0, member_only INTEGER NOT NULL DEFAULT 0, alt_aircraft INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'available'); -- available | held | locked | booked
CREATE TABLE IF NOT EXISTS borrowers (
  id TEXT PRIMARY KEY, legal_name TEXT NOT NULL, entity_type TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  annual_revenue_cents INTEGER NOT NULL, years_in_business REAL NOT NULL, credit_score INTEGER NOT NULL,
  kyc_passed INTEGER NOT NULL, ofac_clear INTEGER NOT NULL, created_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'TX');
CREATE TABLE IF NOT EXISTS memberships (
  email TEXT PRIMARY KEY, plan_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
  deposit_cents INTEGER NOT NULL DEFAULT 0, perks_frozen INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL, next_billing_at TEXT);
CREATE TABLE IF NOT EXISTS membership_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, plan_id TEXT NOT NULL, amount_cents INTEGER NOT NULL,
  credit_granted_cents INTEGER NOT NULL, created_at TEXT NOT NULL);
-- Client money held in the segregated trust account (member trip credit + deposits). Balance per client = sum of entries.
CREATE TABLE IF NOT EXISTS trust_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL,
  kind TEXT NOT NULL, -- deposit | credit_grant | credit_applied | credit_released
  amount_cents INTEGER NOT NULL, ref TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS loans (
  id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id), leg_id TEXT NOT NULL REFERENCES legs(id),
  borrower_id TEXT NOT NULL REFERENCES borrowers(id), status TEXT NOT NULL,
  plan_id TEXT NOT NULL, term_months INTEGER NOT NULL,
  charter_price_cents INTEGER NOT NULL, payout_cents INTEGER NOT NULL,
  down_payment_cents INTEGER NOT NULL, credit_applied_cents INTEGER NOT NULL, cash_down_cents INTEGER NOT NULL,
  down_paid_cents INTEGER NOT NULL DEFAULT 0,
  principal_cents INTEGER NOT NULL, fee_bps INTEGER NOT NULL, fee_cents INTEGER NOT NULL, total_cents INTEGER NOT NULL, apr REAL NOT NULL,
  installments INTEGER NOT NULL, interval_days INTEGER NOT NULL,
  autopay_method TEXT, autopay_last4 TEXT, backup_last4 TEXT,
  decision TEXT NOT NULL, decision_reasons TEXT NOT NULL, risk_tier TEXT,
  review_note TEXT, signed_by TEXT, referral TEXT, collections_stage TEXT,
  group_finalized INTEGER NOT NULL DEFAULT 0, group_n INTEGER NOT NULL DEFAULT 1, group_covered INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, expires_at TEXT, signed_at TEXT, funded_at TEXT, closed_at TEXT);
CREATE INDEX IF NOT EXISTS loans_status ON loans(status);
CREATE INDEX IF NOT EXISTS loans_borrower ON loans(borrower_id);
CREATE TABLE IF NOT EXISTS installments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, loan_id TEXT NOT NULL REFERENCES loans(id), seq INTEGER NOT NULL,
  due_date TEXT NOT NULL, amount_cents INTEGER NOT NULL, principal_cents INTEGER NOT NULL, fee_cents INTEGER NOT NULL,
  paid_cents INTEGER NOT NULL DEFAULT 0, paid_at TEXT, UNIQUE(loan_id, seq));
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY, loan_id TEXT NOT NULL REFERENCES loans(id), kind TEXT NOT NULL, member_id TEXT,
  amount_cents INTEGER NOT NULL, idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(loan_id, idempotency_key));
CREATE TABLE IF NOT EXISTS loan_members (
  id TEXT PRIMARY KEY, loan_id TEXT NOT NULL REFERENCES loans(id), role TEXT NOT NULL, -- main | friend
  name TEXT, email TEXT, invite_token TEXT UNIQUE,
  status TEXT NOT NULL, -- invited | joined | removed | covered | paid_off
  autopay_method TEXT, autopay_last4 TEXT, created_at TEXT NOT NULL, joined_at TEXT);
CREATE TABLE IF NOT EXISTS member_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, loan_id TEXT NOT NULL, member_id TEXT NOT NULL,
  kind TEXT NOT NULL, seq INTEGER NOT NULL, amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL, -- paid | backstopped
  paid_by TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(loan_id, member_id, kind, seq));
CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY, loan_id TEXT NOT NULL REFERENCES loans(id), operator_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL, status TEXT NOT NULL, reference TEXT, created_at TEXT NOT NULL);
-- Charges other than installments (late fees). Capped and off by default.
CREATE TABLE IF NOT EXISTS loan_charges (
  id INTEGER PRIMARY KEY AUTOINCREMENT, loan_id TEXT NOT NULL REFERENCES loans(id), kind TEXT NOT NULL, seq INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL, paid_cents INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE(loan_id, kind, seq));
CREATE TABLE IF NOT EXISTS reminders (
  loan_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (loan_id, seq, kind));
-- Short-lived tokens that let a partner's customer use the embedded checkout without ever seeing the partner API key.
CREATE TABLE IF NOT EXISTS checkout_sessions (
  token_hash TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id), leg_id TEXT NOT NULL REFERENCES legs(id),
  email TEXT, loan_id TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
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
