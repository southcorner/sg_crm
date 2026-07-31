# SG CRM

Zoho Books–backed sales CRM with payment reminders, for a multi-brand business.
Runs as a single Node process on a local Windows server: Express API + built React client
+ (later) cron jobs and a WhatsApp client in the same process.

## Stack

- **Server:** Node.js 22+, Express 4, better-sqlite3 (v12 — v11 does not build on Node 24)
- **Client:** React 18 + Vite, react-router-dom, @tanstack/react-query
- **DB:** SQLite at `data/crm.db` (WAL, foreign keys on)
- **Auth:** single admin login (express-session, SQLite-backed session store)

## Layout

```
sg_crm/
├── server/src/
│   ├── index.js              express app + boot
│   ├── config.js             .env + settings-table config loader
│   ├── db/                   connection.js, migrate.js, migrations/
│   ├── middleware/auth.js    session guard for /api/*
│   ├── routes/               auth.js (+ feature routes per phase)
│   ├── services/             brand/performance/reminder logic (phase 2+)
│   ├── zoho/                 OAuth + sync (phase 1)
│   └── jobs/                 node-cron schedules (phase 4+)
├── server/scripts/           dev-only helpers (seed-fake.js)
├── server/test/              node:test unit tests (npm test -w server)
├── client/src/               pages/, components/, api.js
├── scripts/                  install-service.ps1, backup-db.ps1 (phase 6)
└── data/                     runtime, gitignored: crm.db, wwebjs/ session
```

## Setup

```bash
npm install                 # installs both workspaces
cp .env.example .env        # then edit SESSION_SECRET / ADMIN_PASSWORD
```

On first boot the server creates the single admin user (`ADMIN_USERNAME`, default `admin`)
with `ADMIN_PASSWORD` (default `admin123`) and logs a warning.

## Running

```bash
npm run dev          # server on :3000 + Vite dev server on :5173 (proxies /api)
npm run build        # build the client into client/dist
npm start            # production: one process serves API + client/dist
```

## Zoho Books connection (phase 1)

Create a **Self Client** at [api-console.zoho.in](https://api-console.zoho.in), generate a grant
code for `ZohoBooks.fullaccess.all`, then paste the client id, client secret and grant code into
**Settings → Zoho** within 10 minutes (grant codes expire and are single-use). The refresh token
and organization id are stored in the `settings` table; `.env` `ZOHO_CLIENT_ID` /
`ZOHO_CLIENT_SECRET` act as a fallback.

Sync is manual in phase 1 (**Sync now**, or per entity). Invoice line items need one API call per
invoice, so they are backfilled oldest-first inside the daily call budget
(`zoho_daily_call_budget`, default 2000) and the pass resumes on every sync.

## Tests and dev data

```bash
npm test --workspace=server            # node:test unit tests (mocked Zoho HTTP layer)
npm run seed:fake --workspace=server   # DEV ONLY: fake customers/invoices/payments
npm run seed:fake --workspace=server -- --reset   # wipe synced tables first
```

`server/scripts/seed-fake.js` is never run automatically and refuses to run with
`NODE_ENV=production`. Every row it writes has a `FAKE-` id prefix.

## Build phases

0. **Skeleton** — monorepo, schema + migrations, admin login, Express serves the Vite build ✅
1. **Zoho sync + read-only views** — OAuth, rate-limited client, list syncs + invoice-detail
   queue, sync status UI, Customers/Invoices/Payments pages ✅
2. Brands + performance + targets
3. CRM workflows: focus plans, dormant list, cheque register
4. Reminder engine + email digests
5. WhatsApp digests (whatsapp-web.js)
6. Productionize: Windows service, backups, file logs, runbook
