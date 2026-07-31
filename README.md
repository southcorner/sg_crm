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

## Build phases

0. **Skeleton** — monorepo, schema + migrations, admin login, Express serves the Vite build ✅
1. Zoho sync + read-only Customers/Invoices views
2. Brands + performance + targets
3. CRM workflows: focus plans, dormant list, cheque register
4. Reminder engine + email digests
5. WhatsApp digests (whatsapp-web.js)
6. Productionize: Windows service, backups, file logs, runbook
