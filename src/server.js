import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { CONFIG } from './config.js';
import { openDb } from './db.js';
import { seed, DEMO_PARTNER_KEY } from './seed.js';
import { createApp } from './app.js';
import { sweep } from './services/loans.js';
import { mockRails } from './rails.js';

const dbPath = process.env.DB_PATH ?? ':memory:';
if (dbPath !== ':memory:') mkdirSync(new URL('..', import.meta.url).pathname + 'data', { recursive: true });
const db = openDb(dbPath);
if (!db.prepare('SELECT 1 FROM partners LIMIT 1').get()) seed(db);

const adminKey = process.env.ADMIN_API_KEY ?? 'dev_admin_key';
if (!process.env.ADMIN_API_KEY) console.warn('! ADMIN_API_KEY not set; using insecure dev key "dev_admin_key"');

const app = createApp({ db, adminKey });
createServer(app).listen(CONFIG.port, () => {
  console.log(`SkyFinance listening on http://localhost:${CONFIG.port}`);
  console.log(`Demo partner key: ${DEMO_PARTNER_KEY}`);
});

// Daily housekeeping (expire stale offers, flag defaults) plus a faster pass for offer holds.
const run = () => sweep({ db, now: new Date(), rails: mockRails });
setInterval(run, 60_000).unref();
