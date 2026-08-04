# SG CRM

A Zoho Books–backed sales CRM for a multi-brand business, running on one Windows
machine on the office LAN. It mirrors customers, invoices, payments and items out
of Zoho Books, attributes every invoice to the right sales rep, tracks performance
against monthly targets, keeps the CRM-only workflows Zoho has no place for
(focus plans, dormant customers, a cheque register), and — the part that earns its
keep — mails and WhatsApps each rep a **daily digest of who they need to chase for
money**.

---

## 1. What this is, architecturally

One long-lived Node process does everything: Express serves the JSON API under
`/api` and the built React app for every other path, `node-cron` runs the 09:00
digest and the half-hourly Zoho sync inside that same process, and — when it is
switched on — `whatsapp-web.js` holds a WhatsApp Web session in a headless
Chromium in that same process too. All state lives in a single SQLite file
(`data/crm.db`, WAL mode) which that one process is the only writer of; there is
no queue, no cache, no second service, and nothing to orchestrate. Auth is a
single admin login — reps never sign in, they only receive digests. Restarting
the process is always a safe repair, and the machine itself is the security
boundary.

```
C:\sg_crm\
├── package.json              npm workspaces: server + client
├── .env                      secrets & machine config (gitignored; see .env.example)
├── scripts\
│   ├── install-service.ps1   install/remove the NSSM Windows service
│   ├── backup-db.ps1         nightly VACUUM INTO backup + retention
│   ├── build-installer.ps1   build dist-installer\sg_crm-setup.exe (IExpress)
│   └── installer\            what goes inside that exe:
│       ├── install.cmd       bootstrap run by the exe
│       ├── install.ps1       Node check, in-place update, npm install, launch
│       └── start-server.cmd  runs the server in a window (no service case)
├── server\
│   ├── src\
│   │   ├── index.js          boot, Express app, graceful shutdown
│   │   ├── config.js         .env + `settings` table config
│   │   ├── logger.js         pino -> stdout (+ data\logs\app.log in production)
│   │   ├── db\               connection.js, migrate.js, migrations\*.sql
│   │   ├── zoho\             auth.js (OAuth), client.js (rate limit + budget), sync.js
│   │   ├── services\         attribution, brands, performance, dormant, cheques,
│   │   │                     focus, adminUser, stock, stock-html, stock-report,
│   │   │                     reminders\{engine,email,whatsapp}
│   │   ├── routes\           one router per feature, mounted in routes\index.js
│   │   ├── middleware\auth.js session guard
│   │   └── jobs\cron.js      digest, stock report + sync schedules
│   ├── scripts\backup-db.js  VACUUM INTO worker (called by backup-db.ps1)
│   └── test\                 node:test suites (phase2..phase6, zoho, stock-report, stock-html)
├── client\src\               React 18 + Vite: pages\, components\, api.js
├── client\dist\              build output, served in production (gitignored)
├── dist-installer\           sg_crm-setup.exe (gitignored)
└── data\                     runtime, gitignored
    ├── crm.db (+ -wal, -shm)
    ├── backups\crm-YYYYMMDD-HHMMSS.db
    ├── logs\{app.log, service-out.log, service-err.log, backup.log}
    └── wwebjs\               the WhatsApp session
```

---

## 2. Prerequisites

| Thing | Version | Notes |
|---|---|---|
| Windows | 10 / Server 2016+ | the box must stay powered on — cron lives in the process |
| Node.js | **>= 22** | `better-sqlite3@12` is required; v11 does **not** build on Node 24 |
| git | any | for pulling updates |
| NSSM | 2.24 | service wrapper. `choco install nssm -y`, or unzip from <https://nssm.cc/download> and drop `win64\nssm.exe` in `C:\Windows\System32` |
| Zoho Books | India DC, one org | admin access to create a Self Client |
| SMTP account | — | anything nodemailer can talk to (Zoho Mail, Google Workspace, …) |
| A spare phone + SIM | optional | only if you want the WhatsApp channel |

Chromium for WhatsApp is downloaded by `whatsapp-web.js` during install; that is
why `npm install` is not small.

---

## 3. Install

```powershell
git clone https://github.com/southcorner/sg_crm.git C:\sg_crm
cd C:\sg_crm
npm install                 # both workspaces
copy .env.example .env
notepad .env                # at minimum: SESSION_SECRET
npm run build               # builds client\dist
```

Generate a session secret:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Try it in the foreground before making it a service:

```powershell
$env:NODE_ENV = 'production'
npm start                   # http://localhost:3000 — Ctrl-C to stop
```

Then install the service (**elevated** PowerShell):

```powershell
powershell -ExecutionPolicy Bypass -File C:\sg_crm\scripts\install-service.ps1
```

That registers `SgCrm` to start automatically at boot, run
`node server\src\index.js` from `C:\sg_crm` with `NODE_ENV=production` and
`ENABLE_CRON=true`, restart itself 5 s after a crash (throttled if it is
crash-looping), and capture stdout/stderr to `data\logs\service-out.log` /
`service-err.log` with rotation. Re-run the same script after any code change to
re-apply the configuration; `-Uninstall` removes the service and touches nothing
under `data\`.

Register the nightly backup too (elevated):

```powershell
powershell -ExecutionPolicy Bypass -File C:\sg_crm\scripts\backup-db.ps1 -RegisterTask
```

Finally, open port 3000 to the LAN if other machines need the UI:

```powershell
New-NetFirewallRule -DisplayName "SG CRM" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow
```

### 3.1 Deploying with the setup exe

Everything above is the from-source route. Day to day there is a shorter one:
**one file, copied to the server and double-clicked.**

**On the build machine** (any checkout of this repo):

```powershell
powershell -ExecutionPolicy Bypass -File C:\sg_crm\scripts\build-installer.ps1
# or: npm run installer
```

That builds the client, packs every git-tracked file plus `client\dist` into
`payload.zip`, and wraps it with `install.cmd` / `install.ps1` / `version.txt`
into `dist-installer\sg_crm-setup.exe` using **IExpress**, which ships with
Windows — no extra toolchain. The exe is about **0.7 MB** (source plus the
bundled client; `node_modules` is fetched on the target, not shipped). The
version stamped into it is the build date plus the git short hash, with
`-dirty` appended when the working tree has uncommitted changes; it is printed
during setup and written to `VERSION.txt` in the install directory.

**On the live server:** copy `sg_crm-setup.exe` across and run it. It opens a
console, reports each step, and stays open at the end so you can read it.

1. Checks for **Node.js >= 22**. If it is missing or too old it tries
   `winget install OpenJS.NodeJS.LTS --silent`, and failing that downloads a
   pinned Node 22 LTS x64 MSI from nodejs.org and runs it (UAC prompt), then
   refreshes PATH for itself.
2. Installs to `C:\sg_crm`, or to whatever `SGCRM_DIR` is set to.
3. **Update mode** when the directory already has a `package.json`: app files
   are mirrored over, including deleting files that were removed upstream, but
   `data\`, `.env`, `node_modules\`, `.git\`, `dist-installer\` and `tools\` are
   excluded and never touched. **Fresh mode** otherwise: it creates the
   directory and writes `.env` from `.env.example` with `NODE_ENV=production`
   and a freshly generated 32-byte `SESSION_SECRET`, then warns that the admin
   account will be `admin` / `admin123`.
4. Runs `npm install --omit=dev` (quick when nothing changed).
5. If an `SgCrm` service exists it restarts it and says so; otherwise it opens a
   new terminal window running the server (`scripts\installer\start-server.cmd`).
   Closing that window stops the CRM, so a real deployment should install the
   service once with `scripts\install-service.ps1`.

Database migrations apply themselves at boot, so the patch is complete as soon
as the server is back up. Anything that fails leaves the window open with the
error and exits non-zero, having launched nothing.

**What survives a patch:** the database and everything else under `data\`
(including `wwebjs\` and `backups\`), your `.env` — so `SESSION_SECRET`, SMTP
credentials and `PORT` are all kept — and `node_modules\`. Which means the Zoho
connection, WhatsApp pairing, settings, targets and reminder history all carry
straight over; there is nothing to reconnect after an update.

**First install on a new machine:** run the exe, then follow §5 from the top
(log in, change the password, connect Zoho, and so on). If you are moving an
existing deployment, install with the exe and then copy the old `data\` folder
and `.env` in on top before starting the server — the CRM will come up already
connected.

Useful environment variables when scripting it:

| Variable | Effect |
|---|---|
| `SGCRM_DIR` | Install somewhere other than `C:\sg_crm` |
| `SGCRM_NO_LAUNCH=1` | Do everything except starting the server |
| `SGCRM_NO_PAUSE=1` | Do not wait for a keypress at the end |

---

## 4. `.env` reference

Everything here is machine-level. Anything an admin should be able to change
without a restart lives in **Settings** (the `settings` table) instead.

| Variable | Default | Meaning |
|---|---|---|
| `NODE_ENV` | `development` | `production` serves `client/dist`, logs to `data/logs/app.log`, and enforces the checks below |
| `PORT` | `3000` | HTTP port |
| `SESSION_SECRET` | *(none)* | Signs the session cookie. **Required in production** — the server exits with an explanation if it is missing or shorter than 16 chars |
| `SESSION_COOKIE_SECURE` | `false` | Leave false. `true` sends the cookie over HTTPS only, which makes login impossible without a TLS proxy in front |
| `ADMIN_USERNAME` | `admin` | Only used on first boot to create the single admin |
| `ADMIN_PASSWORD` | `admin123` | Ditto. Change it in Settings → Security afterwards; the server warns loudly while it is still the default |
| `DATA_DIR` | `data` | Root of all runtime state |
| `DB_PATH` | `data/crm.db` | SQLite file |
| `BACKUP_DIR` | `data/backups` | Where `backup-db.ps1` writes |
| `LOG_LEVEL` | `info` in production, else `debug` | `trace…fatal`, or `silent` |
| `LOG_FILE` | `data/logs/app.log` | Override the log file path |
| `LOG_TO_FILE` | on in production | `false` disables the file; `true` enables it in development |
| `LOG_MAX_SIZE_MB` | `10` | Roll `app.log` at this size |
| `LOG_KEEP` | `5` | Keep `app.log.1` … `app.log.5` |
| `LOG_ROTATE_CHECK_MS` | `60000` | How often the size is checked |
| `ZOHO_CLIENT_ID` | — | Self Client id. Fallback only — the UI stores its own copy |
| `ZOHO_CLIENT_SECRET` | — | Self Client secret |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | — | Fallbacks only: Settings → Reminders wins |
| `SMTP_TRANSPORT` | — | Dev escape hatch: `json` or `stream` captures mail instead of sending it. **Leave empty in production** |
| `ENABLE_CRON` | `true` | `false` boots with no schedulers at all |
| `ALLOW_FAKE_SEED` | — | Guard on the fake-data seeder. Never set this on the production box |

The refresh token, organization id, digest schedule, rule windows, API budget and
SMTP settings are stored in the database, not here.

---

## 5. First-run guide

Work through this in order — later steps depend on earlier ones.

### 5.1 Log in and change the password

Open `http://<server>:3000`, log in as `admin` / `admin123` (or whatever you put
in `.env`), then go straight to **Settings → Security** and set a real password.
Until you do, a banner sits on that tab and the server logs a warning at every
boot. There is no password-reset email; if you lose it, stop the service, delete
the row in `admin_user`, put a new `ADMIN_PASSWORD` in `.env` and restart.

### 5.2 Connect Zoho Books

1. Go to <https://api-console.zoho.in> (the **.in** console — this is the India DC)
   and create a **Self Client**.
2. Note the **Client ID** and **Client Secret**.
3. On the *Generate Code* tab, ask for scope `ZohoBooks.fullaccess.all`, pick your
   org, and a duration of 10 minutes. Copy the grant code.
4. **The grant code expires 10 minutes after it is generated and works exactly
   once.** Have the CRM open in another tab before you generate it.
5. In the CRM: **Settings → Zoho → Connect**, paste client id, client secret and
   grant code, press Connect.

The server exchanges the code for a refresh token at `accounts.zoho.in`, stores it
in the `settings` table, fetches your `organization_id` once, and from then on
mints access tokens itself (~55 min each). If a code expires before you paste it,
generate another. To rotate credentials later, connect again with a fresh code —
the same form does both.

### 5.3 Run the first sync, and expect it to take days

Press **Sync now**. The list syncs (salespersons, items, customers, invoices,
payments) are fast — one API call per 200 records. Invoice **line items** are not:
Zoho only returns them from `/invoices/{id}`, i.e. **one API call per invoice**.

The CRM therefore treats the line-item backfill as a background drain: it queues
every invoice with `line_items_synced = 0`, works oldest-first, and stops when the
**daily API budget** (default **2000 calls**, editable on Settings → Zoho) is
spent. It resumes on the next sync. The progress bar under *Invoice line-item
backfill* reads "line items synced N of M".

So: with a few thousand invoices, allow **2–3 days** before Performance and the
brand breakdowns are complete. Customers, invoice totals, payments and the whole
reminder engine are correct from day one — only per-item/brand numbers lag.

Zoho's own cap is roughly 1000–2000 calls/org/day depending on plan; if you have
headroom, raise the budget, and if Zoho starts returning 429, lower it. The client
already backs off on 429/5xx and holds itself to 80 requests/minute.

Once connected, the sync job runs by itself every 30 minutes, 08:00–20:00, Mon–Sat.

### 5.4 Set up the reps

**Reps** page. Each salesperson comes from Zoho (name + Zoho email, refreshed by
every sync, not editable here) and gets three CRM-owned fields you must fill in:

- **CRM email** — where the digest actually goes. Falls back to the Zoho email if blank.
- **WhatsApp number** — 10 digits is assumed to be Indian (+91).
- **Notify by email / by WhatsApp** — per-rep opt-in. A rep with both off gets nothing.

Mark anyone who has left **inactive** so they drop out of digests and target grids.

### 5.5 Brands

**Brands** page. Create your brands, then add ordered **rules** that map items to
them. Rules are evaluated top to bottom, first match wins; the four kinds are Zoho
**custom field**, **category**, **name pattern** and **SKU pattern**. Press
**Re-run rules** and then check the **Unmapped items** list — anything still there
needs another rule or a **manual override**. Manual overrides are never
overwritten by a later rule run, so they are safe.

Brand attribution only covers invoices whose line items have synced (see 5.3), so
expect the unmapped list to shrink over the first few days.

### 5.6 Targets

**Targets** page: a rep × month grid, optionally split by brand. Enter monthly
sales targets; Performance then shows achievement against them, month on month.

### 5.7 Reminders and SMTP

**Settings → Reminders**:

- **Digest send time** — default 09:00, Mon–Sat. Changing it re-registers the cron job immediately, no restart.
- **Overdue after (days past due)**, **ignore balances under (₹)**, **re-nag the same invoice after (days)** — default 7, so a rep is not asked to chase the same invoice every morning.
- **Dormant after (months)** — default 3. Capped at ~10 customers per digest, each mentioned at most once a fortnight.
- **Cheque reminder lead time** — default 3 days before the deposit date, fired once per cheque.

**Automatic rules** — four switches, one per digest section (overdue, cheques,
dormant, focus), all on by default. Switching one off stops it going out with
the **scheduled** digest only: the rule still works and can be fired by hand
from the Reminders page, where paused rules show a *manual* badge. This is how
you say "stop chasing payments for now" without losing the setup. With all four
off the scheduled digest does nothing at all and records nothing, because
nothing was attempted.

The once-a-day guard is keyed on *which sections went out*, not merely on the
rep and the day — so a scheduled dormant+focus digest in the morning does not
block a manual cheque+overdue run that afternoon, while re-running the same
sections on the same day is still refused. Item-level dedupe (the resend window,
one cheque per deposit date, one dormant mention a fortnight) applies to every
run regardless.

Then **Mail server (SMTP)**: host, port (587 STARTTLS / 465 implicit TLS),
username, password (write-only — it is never sent back to the browser) and the
From address. Save, then use **Send a test email**. Finally go to **Reminders →
Run now** with *dry run* ticked to see exactly what each rep would get today.

### 5.8 The dealer stock report

**Settings → Stock Report** — a different audience from everything else in the
CRM: this one goes to **dealers**, so quantities are masked and the artifact is
a file they can search on a phone.

Each mail carries **`Stock <date>.html`**: a self-contained offline browser with
a search box (model, colour or SKU), brand and category chips, and tap-a-model
for its colour breakdown. It needs no network and no app. The email body itself
is only a per-brand summary pointing at the attachment.

**Schedule** (global):

- **Send automatically** — off until you switch it on. It is never enabled by
  default, because it mails people outside the company.
- **Send time** — default 08:30, **every day** (dealers order on Sundays too).
  If the server is switched on *after* this time, the day's mails go out at boot
  rather than skipping the day. Each profile can only go out once per day.
- **Refresh items from Zoho first** — pulls the `items` entity before composing.
  If Zoho is down or disconnected the mails still go out on stored data and say
  so in the footer.

**Recipient profiles** — the report is sent once *per profile*, so different
dealers can get different catalogues from one schedule. A profile is:

- **Recipients** — everyone in a profile is **Bcc**'d, so dealers never see
  each other. A profile with no recipients is never sent.
- **Hide quantities above** — default 25, and per profile. More than this shows
  “Available”; this number or fewer shows the exact count, which is the number a
  dealer actually needs. The rule applies to model totals, colour rows and the
  attachment alike — **the real number is not written into the file at all**, so
  handing it on cannot leak stock depth.
- **Exclude brands / categories** — tick anything that profile should not see.
  `Unbranded` collects items no brand rule has claimed; most setups exclude it.
- **Include in the daily send** — untick to pause a profile without deleting it.

Adding a profile never sends anything immediately: it joins the next scheduled
send. Per profile you can **Preview** the exact mail, **Download file** to check
the attachment yourself, or **Send now** (which still respects that profile's
once-a-day guard unless you pick *Force resend*). Every send is logged on the
**Reminders** page under rule type *Stock report*.

**Custom file** — build a one-off download with its own exclusions and
threshold, for the dealer who asks for “just the rackets”. Nothing is emailed.

Models are grouped automatically: colourways of one racket merge into a single
row with per-colour sub-rows, while genuinely different sub-models (a 4U and a
5U, or “FINAPI 232” and “FINAPI 232 XTRA POWER”) stay apart. Grouping happens
within a brand, so two brands never merge into one invented model.

> Upgrading from the pre-profile version: your existing recipients, exclusions
> and threshold were migrated into a profile called **Default** on first start,
> and the report keeps behaving exactly as before. The old single-config
> settings no longer drive anything.

### 5.9 WhatsApp (optional, and read this honestly)

**Settings → WhatsApp → Enable**, wait ~10–30 s for the headless browser, then on
the phone: **WhatsApp → Settings → Linked devices → Link a device** and scan the
QR shown on the page. The page picks up refreshed codes by itself. When it says
**Ready**, use **Send a test message**.

The honest part:

- `whatsapp-web.js` is **unofficial** and automating WhatsApp is **against
  WhatsApp's terms**. Accounts do get banned. The CRM keeps volume tiny (one
  digest per rep per day, sent one at a time with a random 4–8 s gap), which is
  what people running this pattern get away with, but **the risk is never zero**.
- **Use a dedicated/spare number**, never the owner's personal one.
- It **breaks**. A WhatsApp Web update can stop the library working until it is
  updated (see §7); the phone can also unlink the session on its own. Keep the
  phone online and charged.
- **Email is never affected.** If the session is down at digest time, reps still
  get their email, the log records `session_down`, and the dashboard shows a
  banner. Nothing is retried later — a stale reminder is worse than none.

---

## 6. Daily operation

- **09:00, Mon–Sat** (or whatever you set): one digest per rep, with the sections
  they actually need — 🎯 focus plan (weekly, not daily) · ⚠ overdue invoices
  grouped by customer · 🏦 cheques depositing in 3 days · 😴 dormant customers.
  WhatsApp goes first if the session is up and the rep opted in; email always.
- **Every 30 minutes, 08:00–20:00, Mon–Sat:** Zoho incremental sync.
- **01:00 daily:** the backup task, if you registered it.
- **The Dashboard** is the morning check: outstanding receivables, this month vs
  target, yesterday's digest send status, sync health, and a banner if the API
  budget ran out or the WhatsApp session is down.
- **Reminders** page shows the full log (per rep, per rule, per channel) and has
  **Run now** with a dry-run mode. A real run always honours the dedupe rows, so
  pressing it twice cannot mail anyone twice.
- Day-to-day CRM work: **Focus plan** (this month's target accounts per rep),
  **Dormant** (customers who stopped buying), **Cheques** (register with pending →
  deposited → cleared/bounced), **Customers → Assignments** (move an account to
  another rep, "from today" or re-attributing all history).

Service controls:

```powershell
nssm status SgCrm
nssm restart SgCrm
nssm stop SgCrm
Get-Content C:\sg_crm\data\logs\app.log -Tail 50 -Wait
```

---

## 7. Maintenance

### Backups

`scripts\backup-db.ps1` runs `VACUUM INTO` through better-sqlite3 — a consistent,
compacted copy taken while the service keeps writing, with no `sqlite3.exe`
dependency. It verifies the copy with `integrity_check`, keeps the newest **14**
under `data\backups\`, and appends one line to `data\logs\backup.log`.

```powershell
.\scripts\backup-db.ps1                            # run it now
.\scripts\backup-db.ps1 -Keep 30 -BackupDir D:\crm-backups
.\scripts\backup-db.ps1 -RegisterTask -At 01:00    # elevated; -UnregisterTask to remove
schtasks /Run /TN "SG CRM nightly backup"
```

Copy `data\backups\` off the machine periodically — a backup on the same disk is
not a backup.

**To restore:** stop the service, replace `data\crm.db` with the chosen backup,
delete any leftover `crm.db-wal` / `crm.db-shm`, start the service. A
`VACUUM INTO` copy is a complete standalone database and needs no WAL file.

### Logs

| File | Written by | Rotation |
|---|---|---|
| `data\logs\app.log` | the app (pino) | in-process, at 10 MB, keeping `.1`…`.5` |
| `data\logs\service-out.log` / `service-err.log` | NSSM (raw stdout/stderr) | NSSM, daily or at 10 MB |
| `data\logs\backup.log` | `backup-db.ps1` | none — one short line per night |

`app.log` is JSON, one object per line. To read it comfortably:
`npx pino-pretty < data\logs\app.log`.

### Updating the code

```powershell
nssm stop SgCrm
cd C:\sg_crm
git pull
npm install
npm run build
nssm start SgCrm
```

Migrations run automatically on boot; there is no separate step.

### After a Node.js upgrade

`better-sqlite3` is a native module compiled against a specific Node ABI. A Node
upgrade breaks it with `NODE_MODULE_VERSION … was compiled against a different
version`. Fix:

```powershell
npm rebuild better-sqlite3 --workspace=server
nssm restart SgCrm
```

Keep it on **v12+** — v11 will not build on Node 24.

### When WhatsApp Web breaks

Symptoms: the session sits in `initializing`, or sending fails with a puppeteer
error, usually right after WhatsApp ships a Web update. `whatsapp-web.js` is
**pinned** (`1.34.7`) on purpose, so nothing changes under you until you decide.

```powershell
nssm stop SgCrm
npm install whatsapp-web.js@latest --workspace=server   # check their releases/issues first
npm install
nssm start SgCrm
```

Then Settings → WhatsApp → **Restart**, and re-scan the QR if the session was
lost. If the library has no fix yet, leave WhatsApp disabled — email digests carry
on regardless.

### Housekeeping

- `npm audit` currently reports advisories in transitive dependencies of
  `whatsapp-web.js` (archiver → glob/minimatch), `node-cron` (uuid) and
  `react-router-dom`, plus one in `nodemailer`. None are reachable from untrusted
  input on a LAN-only, single-admin deployment, and the fixes are major-version
  bumps that would break the pinned WhatsApp client. Re-check before any dependency
  upgrade rather than running `npm audit fix --force` on a whim.
- The `settings` table is the source of truth for runtime config. Editing it by
  hand works, but the UI is safer.

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Service will not start; `service-err.log` says "SG CRM cannot start in production" | `SESSION_SECRET` missing or too short in `.env` | Put a 32+ char random string in `.env`, `nssm restart SgCrm` |
| `Port 3000 is already in use` | another `npm start`, or the service is already up | `netstat -ano \| findstr :3000`, stop that PID, or change `PORT` |
| Login rejects the right password | it was changed and forgotten | Stop service → delete the `admin_user` row → set `ADMIN_PASSWORD` in `.env` → start; the account is recreated |
| Banner: "still using the default password" | it is | Settings → Security |
| Zoho **401 / invalid token** on sync | refresh token revoked, credentials rotated, or the Self Client was deleted | Settings → Zoho → generate a **new grant code** at api-console.zoho.in and Connect again (10-minute window) |
| Sync stops mid-way, "API budget exhausted" | the day's call budget is spent — normal during the first backfill | Wait for tomorrow, or raise the budget on Settings → Zoho if Zoho's own quota allows |
| Line-item progress stuck at N of M | same thing: one call per invoice, drained daily | Just time. Watch the bar on Settings → Zoho |
| Invoices show "unknown salesperson" | the Zoho salesperson id/name matches no synced rep | Re-sync salespersons; if the rep left Zoho, reassign the customer on Customers → Assignments |
| WhatsApp stuck in `qr_pending` | nobody scanned it, or the code expired | Re-open Settings → WhatsApp and scan the current code |
| WhatsApp `disconnected`, reps get email only | phone offline, session unlinked, or a WhatsApp Web update broke the library | Settings → WhatsApp → Restart; re-scan; if it persists see §7 |
| Digest never arrived | cron off, the send time passed before the service started, or SMTP is wrong | Settings → Reminders shows the registered job; check `ENABLE_CRON`; use **Send test email**; Reminders → Run now (dry run) |
| Digest arrived twice | cannot happen by design — the per-rep/day row blocks it | If it really did, check `reminders_log` for two `digest` rows and report it |
| `NODE_MODULE_VERSION` error on boot | Node was upgraded | `npm rebuild better-sqlite3 --workspace=server` |
| `database is locked` | something else opened `crm.db` (a DB browser holding a write txn) | Close it. Only the server process may write |
| UI loads but every request 401s | session cookie lost, or `SESSION_COOKIE_SECURE=true` without HTTPS | Set it back to `false`, restart, log in again |
| Blank page but the API works | `client\dist` missing or stale | `npm run build`, then `nssm restart SgCrm` |

---

## 9. Development

```powershell
npm run dev      # server :3000 + Vite :5173 (proxies /api)
npm test         # node:test suites (231 tests, no network, no browser)
npm run build
npm run backup   # node server\scripts\backup-db.js
```

```powershell
npm run seed:fake --workspace=server            # DEV ONLY: fake customers/invoices/payments
npm run seed:fake --workspace=server -- --reset # wipe synced tables first
```

The seeder refuses to run with `NODE_ENV=production` and prefixes every row it
writes with `FAKE-`.

The test suites mock the Zoho HTTP layer and inject fakes for the mailer, the
WhatsApp client and the clock, so nothing opens a socket or launches a browser.

**PowerShell scripts must stay ASCII.** Windows PowerShell 5.1 reads a BOM-less
`.ps1` as ANSI, so a UTF-8 em dash decodes into a smart quote — which PowerShell
happily treats as a string delimiter, breaking the parse in a way the error
message does not hint at. Validate after editing:

```powershell
$e = $null; $t = $null
[System.Management.Automation.Language.Parser]::ParseFile('C:\sg_crm\scripts\backup-db.ps1', [ref]$t, [ref]$e)
$e   # empty = fine
```

---

## 10. Build phases

0. **Skeleton** — monorepo, schema + migrations, admin login, Express serves the Vite build ✅
1. **Zoho sync + read-only views** — OAuth, rate-limited client, list syncs + invoice-detail queue, sync status UI, Customers/Invoices/Payments ✅
2. **Brands + performance + targets** — rules engine, mapping UI, rollups, MoM charts, effective-rep attribution + reassignment ✅
3. **CRM workflows** — focus plans, dormant list, cheque register ✅
4. **Reminder engine + email** — rules, digest composition, nodemailer, cron, log UI, manual run ✅
5. **WhatsApp** — whatsapp-web.js session, QR in Settings, send queue, email fallback ✅
6. **Productionize** — NSSM service, nightly `VACUUM INTO` backups, file logs, password change, this runbook ✅
