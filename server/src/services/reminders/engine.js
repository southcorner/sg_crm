'use strict';

/**
 * The reminder engine — turns the CRM's state into ONE digest per rep per day.
 *
 * Two entry points, deliberately split:
 *
 *   evaluate({date})  PURE. Reads the database (including reminders_log, for the
 *                     dedupe windows) and returns the composed digests. Writes
 *                     nothing, sends nothing. `POST /api/reminders/run` with
 *                     dry_run=1 and the preview UI are exactly this.
 *   run({date})       evaluate → send → log. Everything that touches the outside
 *                     world lives here.
 *
 * Four rules feed the digest; each has its own idempotency window so a rep is
 * nagged about the same thing at a sane cadence rather than every morning:
 *
 *   OVERDUE  non-void, non-draft invoices with balance > 0 whose due date is
 *            further back than `overdue_min_days`, grouped by customer, routed
 *            to the CUSTOMER's effective rep. An invoice re-enters a digest only
 *            once `overdue_resend_days` have passed since it was last sent.
 *   CHEQUE   cheques.chequesDueInDays(cheque_lead_days) — routed to the rep
 *            snapshotted on the cheque. Fires once per cheque per deposit date.
 *   DORMANT  the dormant list, routed to the effective rep, at most 10 per
 *            digest, each customer at most once per 14 days, oldest-reminded
 *            first so the list rotates instead of repeating its top ten.
 *   FOCUS    open focus-plan rows for the current month — Mondays only, plus the
 *            first digest of a month if the rep has not seen it yet.
 *
 * Idempotency is the `reminders_log` table:
 *   * one `digest` row per (run_date, rep) is written BEFORE the send, so a
 *     crash-restart mid-send never double-sends;
 *   * every included item gets a row per channel with the send's outcome, and
 *     only rows with status='sent' count towards the dedupe windows — a failed
 *     send is retried tomorrow rather than silently swallowed.
 *
 * Delivery is a channel registry (`senders`), injectable for tests. Phase 5
 * plugs WhatsApp in by registering another key; nothing else here changes.
 */

const { getDb } = require('../../db/connection');
const config = require('../../config');
const logger = require('../../logger');
const attribution = require('../attribution');
const { todayIso, customerRepIdExpr } = attribution;
const chequeService = require('../cheques');
const dormantService = require('../dormant');
const focusService = require('../focus');
const email = require('./email');
const whatsapp = require('./whatsapp');

// --- constants --------------------------------------------------------------

const RULE = { DIGEST: 'digest', OVERDUE: 'overdue', CHEQUE: 'cheque', DORMANT: 'dormant', FOCUS: 'focus' };

/**
 * The four content rules, in digest order. Each can be switched out of the
 * AUTOMATIC (cron / boot) path independently — `rule_<name>_enabled` — while
 * staying available from the Reminders page. Switching a rule off is how the
 * admin says "stop chasing this for now", not "delete the rule".
 */
const RULE_KEYS = [RULE.OVERDUE, RULE.CHEQUE, RULE.DORMANT, RULE.FOCUS];
const STATUS = {
  PENDING: 'pending',
  SENT: 'sent',
  FAILED: 'failed',
  SKIPPED_DEDUPE: 'skipped_dedupe',
  SKIPPED: 'skipped',
};

// Email first, deliberately: it is the channel that must never be delayed by a
// WhatsApp session that has gone quiet.
const CHANNELS = ['email', 'whatsapp'];
const DORMANT_MAX_PER_DIGEST = 10;
const DORMANT_SUPPRESS_DAYS = 14;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// --- small helpers ----------------------------------------------------------

const addDays = chequeService.addDays;

/** Whole days from a → b (both YYYY-MM-DD), computed in UTC. */
function daysBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  return Math.round(
    (Date.parse(`${String(toIso).slice(0, 10)}T00:00:00Z`) - Date.parse(`${String(fromIso).slice(0, 10)}T00:00:00Z`)) /
      86400000
  );
}

/** A Date pinned to midday of `iso`, so callers that expect a `now` behave. */
function noonOf(iso) {
  return new Date(`${iso}T12:00:00`);
}

/** 'YYYY-MM-DD' → '01 Aug 2026' (fixed, locale-independent). */
function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d} ${MONTHS[Number(m) - 1] || m} ${y}`;
}

const inrWhole = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const inrPaise = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** ₹1,42,159.90 / ₹76,250 — paise only when there are any. */
function inr(amount) {
  const n = Math.round((Number(amount) || 0) * 100) / 100;
  return `₹${Number.isInteger(n) ? inrWhole.format(n) : inrPaise.format(n)}`;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function esc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function intSetting(key, fallback, min, max) {
  const n = Math.trunc(Number(config.getSetting(key, fallback)));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function numSetting(key, fallback, min, max) {
  const n = Number(config.getSetting(key, fallback));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** Every knob the rules read, resolved once per evaluation. */
function settingsSnapshot() {
  return {
    overdueMinDays: intSetting('overdue_min_days', 1, 0, 365),
    overdueMinAmount: numSetting('overdue_min_amount', 0, 0, 1e12),
    overdueResendDays: intSetting('overdue_resend_days', 7, 1, 365),
    chequeLeadDays: chequeService.leadDays(),
    dormantMonths: dormantService.dormantMonths(),
    digestSendTime: String(config.getSetting('digest_send_time', '09:00')),
    automaticRules: automaticRules(),
  };
}

// ---------------------------------------------------------------------------
// rule selection
// ---------------------------------------------------------------------------

/**
 * Which rules the SCHEDULED digest is allowed to send. Manual runs ignore this
 * — the whole point of switching a rule off is that a human can still fire it
 * deliberately from the Reminders page.
 */
function automaticRules() {
  return RULE_KEYS.filter((key) => Boolean(config.getSetting(`rule_${key}_enabled`, true)));
}

/** Normalise a caller's rule list: unknown names dropped, digest order kept. */
function normalizeRules(rules) {
  if (rules === undefined || rules === null) return [...RULE_KEYS];
  const wanted = new Set((Array.isArray(rules) ? rules : [rules]).map((r) => String(r)));
  return RULE_KEYS.filter((key) => wanted.has(key));
}

/**
 * The dedupe identity of a digest: which rep, which day, which rules.
 *
 * Keying the per-rep/day guard on the RULE SET (rather than on "this rep is
 * done today") is what lets a scheduled dormant+focus digest at 09:00 coexist
 * with a manual cheque+overdue run at 15:00 — different rule sets, different
 * guard rows, neither blocks the other. Re-running the SAME set on the same day
 * is still refused, so crash-restart safety is preserved on every path,
 * scheduled and manual alike (a "manual runs always bypass the guard" rule
 * would have given that up).
 */
function rulesKey(rules) {
  return [...rules].sort().join(',');
}

const ALL_RULES_KEY = rulesKey(RULE_KEYS);

/** Empty rule results, so a rule that was not selected costs nothing to skip. */
const NO_OVERDUE = { groups: [], suppressed: [], unrouted: 0, cutoff: null, resendOn: null, skipped: true };
const NO_CHEQUE = { items: [], suppressed: [], unrouted: 0, leadDays: null, skipped: true };
const NO_DORMANT = { eligible: [], suppressed: [], unrouted: 0, months: null, threshold: null, total: 0, skipped: true };
const NO_FOCUS = { month: null, isMonday: false, included: new Map(), suppressed: [], unrouted: 0, skipped: true };

// ---------------------------------------------------------------------------
// reps
// ---------------------------------------------------------------------------

/**
 * Reps that may receive a digest: active only. `notify_email` and a usable
 * address decide whether the email channel is eligible — an active rep with the
 * flag off is still evaluated (so the preview shows what they *would* get) but
 * run() finds no channel and records a skip rather than sending.
 *
 * Reps hidden by the global rep visibility scope are dropped entirely: no
 * digest, no log row, nothing. The admin has said this CRM is not about them.
 *
 * WhatsApp is listed as a channel for EVERY rep while the feature is switched on,
 * even for reps with no number or the flag off. That is on purpose: the sender
 * then fails with `no_number` / `opted_out` / `session_down` and the reminder log
 * says out loud why a rep did not get a WhatsApp message, instead of the channel
 * silently disappearing. With `whatsapp_enabled` false — the default — no
 * whatsapp rows are written at all.
 */
function digestReps() {
  const waEnabled = whatsapp.isEnabled();
  const visible = attribution.visibleRepIds();
  return getDb()
    .prepare(
      `SELECT zoho_salesperson_id AS id, name, email, crm_email, whatsapp_number,
              notify_email, notify_whatsapp
         FROM salespersons
        WHERE is_active = 1
        ORDER BY name ASC`
    )
    .all()
    .filter((r) => visible === null || visible.includes(r.id))
    .map((r) => {
      const address = (r.crm_email || r.email || '').trim() || null;
      return {
        id: r.id,
        name: r.name,
        email: address,
        email_source: r.crm_email ? 'crm_email' : r.email ? 'zoho' : null,
        notify_email: Boolean(r.notify_email),
        notify_whatsapp: Boolean(r.notify_whatsapp),
        whatsapp_number: r.whatsapp_number || null,
        channels: [...(r.notify_email && address ? ['email'] : []), ...(waEnabled ? ['whatsapp'] : [])],
      };
    });
}

// ---------------------------------------------------------------------------
// rule: overdue invoices
// ---------------------------------------------------------------------------

/**
 * Overdue invoices grouped by customer.
 *
 * Boundary, stated once so the tests can assert it: an invoice qualifies when
 * `due_date < runDate − overdue_min_days`. With the default of 1 that means an
 * invoice due yesterday is NOT chased yet; two days past due is.
 *
 * `overdue_min_amount` filters per invoice, not per customer — the point is to
 * stop the digest listing ₹40 stragglers, not to hide a customer who owes a lot
 * across many small bills.
 */
function overdueRule(runDate, settings) {
  const db = getDb();
  const cutoff = addDays(runDate, -settings.overdueMinDays);
  const resendOn = addDays(runDate, -settings.overdueResendDays);
  // routed to the customer's effective rep, so scope on the customer
  const scope = attribution.customerScopeFilter('c');

  const rows = db
    .prepare(
      `SELECT i.zoho_invoice_id AS invoice_id,
              i.invoice_number,
              i.customer_id,
              COALESCE(c.contact_name, i.customer_name) AS customer_name,
              c.mobile,
              i.invoice_date,
              i.due_date,
              i.balance,
              i.status,
              ${customerRepIdExpr('c')} AS rep_id,
              (SELECT MAX(r.run_date) FROM reminders_log r
                WHERE r.rule_type = 'overdue' AND r.entity_type = 'invoice'
                  AND r.entity_id = i.zoho_invoice_id AND r.status = 'sent') AS last_reminded
         FROM invoices i
         JOIN customers c ON c.zoho_contact_id = i.customer_id
        WHERE i.status NOT IN ('void', 'draft')
          AND i.balance > 0
          AND i.balance >= @minAmount
          AND i.due_date IS NOT NULL
          AND i.due_date < @cutoff
          AND ${scope.sql}
        ORDER BY i.due_date ASC, i.invoice_number ASC`
    )
    .all({ cutoff, minAmount: settings.overdueMinAmount, ...scope.params });

  const byCustomer = new Map();
  const suppressed = [];
  let unrouted = 0;

  for (const row of rows) {
    // re-nag window: only rows never sent, or last sent >= overdue_resend_days ago
    if (row.last_reminded && row.last_reminded > resendOn) {
      suppressed.push({ invoice_id: row.invoice_id, last_reminded: row.last_reminded });
      continue;
    }
    if (!row.rep_id) {
      unrouted += 1;
      continue;
    }
    const key = `${row.rep_id}::${row.customer_id}`;
    if (!byCustomer.has(key)) {
      byCustomer.set(key, {
        rep_id: row.rep_id,
        customer_id: row.customer_id,
        customer_name: row.customer_name,
        mobile: row.mobile,
        total: 0,
        oldest_days_overdue: 0,
        invoices: [],
      });
    }
    const group = byCustomer.get(key);
    const daysOverdue = daysBetween(row.due_date, runDate);
    group.total = round2(group.total + row.balance);
    group.oldest_days_overdue = Math.max(group.oldest_days_overdue, daysOverdue);
    group.invoices.push({
      invoice_id: row.invoice_id,
      invoice_number: row.invoice_number,
      due_date: row.due_date,
      balance: round2(row.balance),
      days_overdue: daysOverdue,
      last_reminded: row.last_reminded,
    });
  }

  return {
    groups: [...byCustomer.values()].sort((a, b) => b.total - a.total || b.oldest_days_overdue - a.oldest_days_overdue),
    suppressed,
    unrouted,
    cutoff,
    resendOn,
  };
}

// ---------------------------------------------------------------------------
// rule: cheques due
// ---------------------------------------------------------------------------

/** Has this cheque already been announced for THIS deposit date? */
function chequeAlreadySent(chequeId, depositDate) {
  const row = getDb()
    .prepare(
      `SELECT 1 AS hit FROM reminders_log
        WHERE rule_type = 'cheque' AND entity_type = 'cheque' AND entity_id = @id
          AND status = 'sent'
          AND json_extract(detail, '$.deposit_date') = @deposit
        LIMIT 1`
    )
    .get({ id: String(chequeId), deposit: depositDate });
  return Boolean(row);
}

function chequeRule(runDate, settings) {
  const due = chequeService.chequesDueInDays(settings.chequeLeadDays, { now: noonOf(runDate) });
  const items = [];
  const suppressed = [];
  let unrouted = 0;

  for (const cheque of due) {
    if (chequeAlreadySent(cheque.id, cheque.deposit_date)) {
      suppressed.push({ cheque_id: cheque.id, deposit_date: cheque.deposit_date });
      continue;
    }
    if (!cheque.rep_id) {
      unrouted += 1;
      continue;
    }
    items.push({
      rep_id: cheque.rep_id,
      cheque_id: cheque.id,
      customer_id: cheque.customer_id,
      customer_name: cheque.customer_name,
      cheque_number: cheque.cheque_number,
      bank_name: cheque.bank_name,
      amount: round2(cheque.amount),
      deposit_date: cheque.deposit_date,
      days_to_deposit: cheque.days_to_deposit,
    });
  }

  return { items, suppressed, unrouted, leadDays: settings.chequeLeadDays };
}

// ---------------------------------------------------------------------------
// rule: dormant customers
// ---------------------------------------------------------------------------

function dormantRule(runDate, settings) {
  const list = dormantService.listDormant({ months: settings.dormantMonths, now: noonOf(runDate) });
  const lastByCustomer = new Map(
    getDb()
      .prepare(
        `SELECT entity_id, MAX(run_date) AS last_reminded
           FROM reminders_log
          WHERE rule_type = 'dormant' AND entity_type = 'customer' AND status = 'sent'
          GROUP BY entity_id`
      )
      .all()
      .map((r) => [r.entity_id, r.last_reminded])
  );

  const suppressOn = addDays(runDate, -DORMANT_SUPPRESS_DAYS);
  const eligible = [];
  const suppressed = [];
  let unrouted = 0;

  for (const row of list.rows) {
    const lastReminded = lastByCustomer.get(row.id) || null;
    if (lastReminded && lastReminded > suppressOn) {
      suppressed.push({ customer_id: row.id, last_reminded: lastReminded });
      continue;
    }
    if (!row.effective_rep_id) {
      unrouted += 1;
      continue;
    }
    eligible.push({
      rep_id: row.effective_rep_id,
      customer_id: row.id,
      customer_name: row.contact_name,
      mobile: row.mobile,
      last_invoice_date: row.last_invoice_date,
      months_dormant: row.months_dormant,
      outstanding: round2(row.outstanding_receivable),
      last_reminded: lastReminded,
      in_focus: row.in_focus,
    });
  }

  // rotation: whoever has waited longest goes first, then by money at stake.
  // The per-rep cap is applied after grouping so one rep's queue cannot eat
  // another's slots.
  eligible.sort(
    (a, b) =>
      (a.last_reminded || '').localeCompare(b.last_reminded || '') ||
      b.outstanding - a.outstanding ||
      String(a.customer_name).localeCompare(String(b.customer_name))
  );

  return { eligible, suppressed, unrouted, months: list.months, threshold: list.threshold, total: list.total };
}

// ---------------------------------------------------------------------------
// rule: focus plan
// ---------------------------------------------------------------------------

/** Has this rep already had the focus section in a digest this month? */
function focusSentThisMonth(repId, month) {
  const row = getDb()
    .prepare(
      `SELECT 1 AS hit FROM reminders_log
        WHERE rule_type = 'focus' AND salesperson_id = @rep AND status = 'sent'
          AND substr(run_date, 1, 7) = @month
        LIMIT 1`
    )
    .get({ rep: repId, month });
  return Boolean(row);
}

/**
 * Focus is the "weekly, not daily" section: Mondays for everyone, plus a
 * catch-up for any rep who has not seen the month's plan yet (new plan added
 * mid-week, rep joined, first run of the month on a Tuesday...).
 */
function focusRule(runDate) {
  const month = runDate.slice(0, 7);
  const isMonday = noonOf(runDate).getDay() === 1;
  const rows = focusService.listFocus(month, { now: noonOf(runDate) }).rows.filter((r) => r.status === 'open');

  const byRep = new Map();
  let unrouted = 0;
  for (const row of rows) {
    if (!row.salesperson_id) {
      unrouted += 1;
      continue;
    }
    if (!byRep.has(row.salesperson_id)) byRep.set(row.salesperson_id, []);
    byRep.get(row.salesperson_id).push({
      rep_id: row.salesperson_id,
      focus_id: row.id,
      customer_id: row.customer_id,
      customer_name: row.customer_name,
      note: row.note,
      outstanding: round2(row.outstanding_receivable),
      last_invoice_date: row.last_invoice_date,
    });
  }

  const included = new Map();
  const suppressed = [];
  for (const [repId, items] of byRep) {
    const firstOfMonth = !focusSentThisMonth(repId, month);
    if (isMonday || firstOfMonth) included.set(repId, { items, reason: isMonday ? 'monday' : 'first_of_month' });
    else suppressed.push({ rep_id: repId, count: items.length, reason: 'weekly_cadence' });
  }

  return { month, isMonday, included, suppressed, unrouted };
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function summaryLine(counts) {
  const bits = [];
  if (counts.overdue) bits.push(`${counts.overdue} overdue customer${counts.overdue === 1 ? '' : 's'}`);
  if (counts.cheques) bits.push(`${counts.cheques} cheque${counts.cheques === 1 ? '' : 's'} due`);
  if (counts.dormant) bits.push(`${counts.dormant} dormant`);
  if (counts.focus) bits.push(`${counts.focus} focus`);
  return bits.join(' · ');
}

function renderText(digest) {
  const { rep, sections, counts, runDate, settings } = digest;
  const lines = [];
  lines.push(`${rep.name} — SG CRM digest for ${WEEKDAYS[noonOf(runDate).getDay()]}, ${fmtDate(runDate)}`);
  lines.push(summaryLine(counts) || 'Nothing outstanding.');

  if (sections.focus.length) {
    lines.push('', `🎯 FOCUS PLAN (${digest.focusMonth}) — ${sections.focus.length} open`);
    for (const f of sections.focus) {
      lines.push(`• ${f.customer_name}${f.note ? ` — ${f.note}` : ''}${f.outstanding ? ` (${inr(f.outstanding)} outstanding)` : ''}`);
    }
  }

  if (sections.overdue.length) {
    lines.push('', `⚠ OVERDUE — ${sections.overdue.length} customer(s), ${inr(counts.overdueAmount)}`);
    for (const g of sections.overdue) {
      lines.push(
        `• ${g.customer_name} — ${inr(g.total)} · oldest ${g.oldest_days_overdue} day(s) overdue · ` +
          g.invoices.map((i) => i.invoice_number || i.invoice_id).join(', ')
      );
    }
  }

  if (sections.cheques.length) {
    lines.push('', `🏦 CHEQUES DUE IN ${settings.chequeLeadDays} DAY(S) — ${inr(counts.chequeAmount)}`);
    for (const c of sections.cheques) {
      lines.push(
        `• Remind ${c.customer_name} cheque #${c.cheque_number || '—'} for ${inr(c.amount)} deposits on ` +
          `${fmtDate(c.deposit_date)}${c.bank_name ? ` (${c.bank_name})` : ''}`
      );
    }
  }

  if (sections.dormant.length) {
    lines.push('', `😴 DORMANT — ${sections.dormant.length} customer(s) to win back`);
    for (const d of sections.dormant) {
      lines.push(
        `• ${d.customer_name} — last invoice ${fmtDate(d.last_invoice_date)} (${d.months_dormant} month(s))` +
          (d.outstanding ? ` · ${inr(d.outstanding)} outstanding` : '')
      );
    }
  }

  lines.push('', 'Sent automatically by SG CRM. Reply to your manager, not to this mailbox.');
  return lines.join('\n');
}

const CSS = {
  body: 'margin:0;padding:24px;background:#f4f5f7;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2933;',
  card: 'max-width:640px;margin:0 auto;background:#ffffff;border-radius:10px;padding:24px;border:1px solid #e2e6ea;',
  h1: 'margin:0 0 4px;font-size:19px;font-weight:600;color:#12263f;',
  sub: 'margin:0 0 20px;font-size:13px;color:#6b7785;',
  h2: 'margin:22px 0 8px;font-size:15px;font-weight:600;color:#12263f;',
  table: 'width:100%;border-collapse:collapse;font-size:13px;',
  th: 'text-align:left;padding:6px 8px;background:#f4f5f7;color:#52606d;font-weight:600;border-bottom:1px solid #e2e6ea;',
  td: 'padding:6px 8px;border-bottom:1px solid #eef1f4;vertical-align:top;',
  right: 'text-align:right;white-space:nowrap;',
  foot: 'margin:24px 0 0;font-size:11px;color:#9aa5b1;',
};

function htmlTable(headers, rows) {
  const head = headers
    .map((h) => `<th style="${CSS.th}${h.right ? CSS.right : ''}">${esc(h.label)}</th>`)
    .join('');
  const body = rows
    .map(
      (cells) =>
        `<tr>${cells
          .map((c) => `<td style="${CSS.td}${c.right ? CSS.right : ''}">${c.html}</td>`)
          .join('')}</tr>`
    )
    .join('');
  return `<table style="${CSS.table}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderHtml(digest) {
  const { rep, sections, counts, runDate, settings } = digest;
  const parts = [];
  parts.push(`<div style="${CSS.body}"><div style="${CSS.card}">`);
  parts.push(`<h1 style="${CSS.h1}">Good morning, ${esc(rep.name)}</h1>`);
  parts.push(
    `<p style="${CSS.sub}">Your SG CRM digest for ${WEEKDAYS[noonOf(runDate).getDay()]}, ${fmtDate(runDate)}` +
      `${summaryLine(counts) ? ` — ${esc(summaryLine(counts))}` : ''}.</p>`
  );

  if (sections.focus.length) {
    parts.push(`<h2 style="${CSS.h2}">🎯 Focus plan — ${esc(digest.focusMonth)}</h2>`);
    parts.push(
      htmlTable(
        [{ label: 'Customer' }, { label: 'Note' }, { label: 'Outstanding', right: true }],
        sections.focus.map((f) => [
          { html: esc(f.customer_name) },
          { html: esc(f.note || '—') },
          { html: esc(inr(f.outstanding)), right: true },
        ])
      )
    );
  }

  if (sections.overdue.length) {
    parts.push(`<h2 style="${CSS.h2}">⚠ Overdue — ${esc(inr(counts.overdueAmount))}</h2>`);
    parts.push(
      htmlTable(
        [{ label: 'Customer' }, { label: 'Invoices' }, { label: 'Oldest', right: true }, { label: 'Balance', right: true }],
        sections.overdue.map((g) => [
          { html: `<strong>${esc(g.customer_name)}</strong>` },
          { html: esc(g.invoices.map((i) => i.invoice_number || i.invoice_id).join(', ')) },
          { html: `${g.oldest_days_overdue} d`, right: true },
          { html: `<strong>${esc(inr(g.total))}</strong>`, right: true },
        ])
      )
    );
  }

  if (sections.cheques.length) {
    parts.push(`<h2 style="${CSS.h2}">🏦 Cheques depositing in ${settings.chequeLeadDays} day(s)</h2>`);
    parts.push(
      htmlTable(
        [{ label: 'Customer' }, { label: 'Cheque' }, { label: 'Deposits on' }, { label: 'Amount', right: true }],
        sections.cheques.map((c) => [
          { html: esc(c.customer_name) },
          { html: esc(`#${c.cheque_number || '—'}${c.bank_name ? ` · ${c.bank_name}` : ''}`) },
          { html: esc(fmtDate(c.deposit_date)) },
          { html: `<strong>${esc(inr(c.amount))}</strong>`, right: true },
        ])
      )
    );
  }

  if (sections.dormant.length) {
    parts.push(`<h2 style="${CSS.h2}">😴 Dormant — no invoice in ${digest.dormantMonths}+ months</h2>`);
    parts.push(
      htmlTable(
        [{ label: 'Customer' }, { label: 'Last invoice' }, { label: 'Dormant', right: true }, { label: 'Outstanding', right: true }],
        sections.dormant.map((d) => [
          { html: esc(d.customer_name) },
          { html: esc(fmtDate(d.last_invoice_date)) },
          { html: `${d.months_dormant} mo`, right: true },
          { html: esc(inr(d.outstanding)), right: true },
        ])
      )
    );
  }

  parts.push(`<p style="${CSS.foot}">Sent automatically by SG CRM · ${esc(runDate)}</p>`);
  parts.push('</div></div>');
  return parts.join('');
}

// ---------------------------------------------------------------------------
// evaluation (pure)
// ---------------------------------------------------------------------------

/**
 * Compose every digest for `date` without touching anything.
 *
 * @param {object} opts
 * @param {string} [opts.date]  YYYY-MM-DD; defaults to today
 * @param {Date}   [opts.now]   injectable clock (tests)
 * @param {string} [opts.rep]   restrict the result to one rep (preview UI)
 * @returns {{runDate, digests, settings, stats}}
 */
function evaluate({ date, now = new Date(), rep: repFilter = null, rules = null } = {}) {
  const runDate = date || todayIso(now);
  const settings = settingsSnapshot();
  const activeRules = normalizeRules(rules);
  const active = new Set(activeRules);

  // a rule that was not asked for is never even queried
  const overdue = active.has(RULE.OVERDUE) ? overdueRule(runDate, settings) : NO_OVERDUE;
  const cheques = active.has(RULE.CHEQUE) ? chequeRule(runDate, settings) : NO_CHEQUE;
  const dormant = active.has(RULE.DORMANT) ? dormantRule(runDate, settings) : NO_DORMANT;
  const focus = active.has(RULE.FOCUS) ? focusRule(runDate) : NO_FOCUS;

  const reps = digestReps().filter((r) => !repFilter || r.id === repFilter);
  const digests = [];

  for (const rep of reps) {
    const focusEntry = focus.included.get(rep.id);
    const sections = {
      focus: focusEntry ? focusEntry.items : [],
      overdue: overdue.groups.filter((g) => g.rep_id === rep.id),
      cheques: cheques.items.filter((c) => c.rep_id === rep.id),
      dormant: dormant.eligible.filter((d) => d.rep_id === rep.id).slice(0, DORMANT_MAX_PER_DIGEST),
    };

    const counts = {
      focus: sections.focus.length,
      overdue: sections.overdue.length,
      overdueInvoices: sections.overdue.reduce((n, g) => n + g.invoices.length, 0),
      overdueAmount: round2(sections.overdue.reduce((n, g) => n + g.total, 0)),
      cheques: sections.cheques.length,
      chequeAmount: round2(sections.cheques.reduce((n, c) => n + c.amount, 0)),
      dormant: sections.dormant.length,
    };

    // reps with nothing to say get no digest at all
    if (!counts.focus && !counts.overdue && !counts.cheques && !counts.dormant) continue;

    const digest = {
      runDate,
      rep,
      sections,
      counts,
      settings,
      focusMonth: focus.month,
      focusReason: focusEntry ? focusEntry.reason : null,
      dormantMonths: dormant.months,
      items: buildItems(sections),
    };
    digest.subject = `SG CRM digest · ${fmtDate(runDate)} · ${summaryLine(counts) || 'nothing outstanding'}`;
    digest.text = renderText(digest);
    digest.html = renderHtml(digest);
    digests.push(digest);
  }

  return {
    runDate,
    settings,
    rules: activeRules,
    rulesKey: rulesKey(activeRules),
    digests,
    stats: {
      reps: reps.length,
      digests: digests.length,
      rules: activeRules,
      overdue: {
        candidates: overdue.groups.length,
        suppressed: overdue.suppressed.length,
        unrouted: overdue.unrouted,
        cutoff: overdue.cutoff,
        resendOn: overdue.resendOn,
      },
      cheque: { candidates: cheques.items.length, suppressed: cheques.suppressed.length, unrouted: cheques.unrouted },
      dormant: {
        candidates: dormant.eligible.length,
        suppressed: dormant.suppressed.length,
        unrouted: dormant.unrouted,
        total: dormant.total,
        threshold: dormant.threshold,
        cap: DORMANT_MAX_PER_DIGEST,
      },
      focus: {
        month: focus.month,
        isMonday: focus.isMonday,
        included: focus.included.size,
        suppressed: focus.suppressed.length,
        unrouted: focus.unrouted,
      },
    },
  };
}

/** Flatten a digest's sections into the rows reminders_log will carry. */
function buildItems(sections) {
  const items = [];
  for (const f of sections.focus) {
    items.push({
      rule_type: RULE.FOCUS,
      entity_type: 'focus_plan',
      entity_id: String(f.focus_id),
      detail: { label: f.customer_name, customer_id: f.customer_id, note: f.note },
    });
  }
  for (const g of sections.overdue) {
    for (const inv of g.invoices) {
      items.push({
        rule_type: RULE.OVERDUE,
        entity_type: 'invoice',
        entity_id: String(inv.invoice_id),
        detail: {
          label: `${inv.invoice_number || inv.invoice_id} · ${g.customer_name}`,
          customer_id: g.customer_id,
          balance: inv.balance,
          days_overdue: inv.days_overdue,
        },
      });
    }
  }
  for (const c of sections.cheques) {
    items.push({
      rule_type: RULE.CHEQUE,
      entity_type: 'cheque',
      entity_id: String(c.cheque_id),
      detail: {
        label: `#${c.cheque_number || c.cheque_id} · ${c.customer_name}`,
        customer_id: c.customer_id,
        deposit_date: c.deposit_date,
        amount: c.amount,
      },
    });
  }
  for (const d of sections.dormant) {
    items.push({
      rule_type: RULE.DORMANT,
      entity_type: 'customer',
      entity_id: String(d.customer_id),
      detail: {
        label: d.customer_name,
        last_invoice_date: d.last_invoice_date,
        months_dormant: d.months_dormant,
      },
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------------

function insertLog({ runDate, ruleType, entityType = null, entityId = null, repId = null, channel = null, status, detail = null }) {
  const info = getDb()
    .prepare(
      `INSERT INTO reminders_log (run_date, rule_type, entity_type, entity_id, salesperson_id, channel, status, detail)
       VALUES (@run_date, @rule_type, @entity_type, @entity_id, @salesperson_id, @channel, @status, @detail)`
    )
    .run({
      run_date: runDate,
      rule_type: ruleType,
      entity_type: entityType,
      entity_id: entityId,
      salesperson_id: repId,
      channel,
      status,
      detail: detail === null ? null : JSON.stringify(detail),
    });
  return Number(info.lastInsertRowid);
}

function updateLogStatus(id, status, detail) {
  getDb()
    .prepare('UPDATE reminders_log SET status = ?, detail = ? WHERE id = ?')
    .run(status, detail === undefined || detail === null ? null : JSON.stringify(detail), id);
}

/** The crash-restart guard: any digest row for this rep+date means "done". */
/**
 * Has this rep already had a digest for THIS rule set today?
 *
 * `entity_id` on a digest row carries the sorted rule set. Rows written before
 * rule selection existed have NULL there and mean "all four", so a plain
 * all-rules run still recognises them — otherwise the upgrade itself would
 * double-send on its first day.
 */
function digestAlreadyRun(runDate, repId, key = ALL_RULES_KEY) {
  return Boolean(
    getDb()
      .prepare(
        `SELECT 1 AS hit FROM reminders_log
          WHERE run_date = @run_date AND rule_type = 'digest' AND salesperson_id = @rep
            AND status <> 'skipped_dedupe'
            AND (entity_id = @key OR (entity_id IS NULL AND @is_all = 1))
          LIMIT 1`
      )
      .get({ run_date: runDate, rep: repId, key, is_all: key === ALL_RULES_KEY ? 1 : 0 })
  );
}

// ---------------------------------------------------------------------------
// delivery
// ---------------------------------------------------------------------------

/**
 * Channel registry. A sender takes the composed digest and resolves with
 * anything worth logging, or throws — the engine records `failed` and moves on
 * to the next channel/rep.
 *
 * The WhatsApp sender throws one of three bare reasons so the log reads as a
 * diagnosis rather than a stack trace:
 *   opted_out     the rep has notify_whatsapp off
 *   no_number     nobody has filled in whatsapp_number on Reps
 *   session_down  the phone is unlinked / the session broke — scan the QR again
 * Whatever happens here, email has already been attempted: WhatsApp failing is
 * never a reason for a rep to hear nothing. Nothing is retried later — a digest
 * is a snapshot of a morning, and a stale one is worse than none.
 */
function defaultSenders() {
  return {
    email: async (digest) => {
      const info = await email.sendEmail(digest.rep.email, digest.subject, digest.html, digest.text);
      return { to: digest.rep.email, messageId: info.messageId || null };
    },
    whatsapp: async (digest) => {
      const { rep } = digest;
      if (!rep.notify_whatsapp) throw new Error(whatsapp.REASON.OPTED_OUT);
      if (!rep.whatsapp_number) throw new Error(whatsapp.REASON.NO_NUMBER);
      if (!whatsapp.isReady()) throw new Error(whatsapp.REASON.SESSION_DOWN);
      const info = await whatsapp.sendMessage(rep.whatsapp_number, digest.text);
      return { to: info.to, messageId: info.id || null };
    },
  };
}

// ---------------------------------------------------------------------------
// run (evaluate → send → log)
// ---------------------------------------------------------------------------

/**
 * @param {object}   opts
 * @param {string}   [opts.date]     YYYY-MM-DD
 * @param {string[]} [opts.channels] delivery channels to attempt (default: email)
 * @param {boolean}  [opts.dryRun]   compose only — writes nothing, sends nothing
 * @param {object}   [opts.senders]  channel → async fn (injected by tests)
 * @param {string}   [opts.rep]      restrict to one rep
 */
async function run({ date, now = new Date(), channels = CHANNELS, dryRun = false, senders, rep = null, rules = null } = {}) {
  const activeRules = normalizeRules(rules);

  // Every rule switched off: there is nothing to attempt, so nothing is
  // recorded either — an empty run must not look like "the digest went out".
  if (!activeRules.length) {
    const runDate = date || todayIso(now);
    logger.info({ runDate }, 'digest skipped — no rules selected');
    return {
      runDate,
      settings: settingsSnapshot(),
      rules: [],
      rulesKey: '',
      digests: [],
      stats: { reps: 0, digests: 0, rules: [] },
      dryRun: Boolean(dryRun),
      channels: [],
      results: [],
      skipped: 'no rules selected',
    };
  }

  const evaluation = evaluate({ date, now, rep, rules: activeRules });
  const { runDate } = evaluation;
  const key = evaluation.rulesKey;

  if (dryRun) {
    return { ...evaluation, dryRun: true, channels, results: evaluation.digests.map((d) => dryResult(d, channels, key)) };
  }

  const registry = senders || defaultSenders();
  const wanted = channels.filter((c) => registry[c]);
  const results = [];

  for (const digest of evaluation.digests) {
    const repId = digest.rep.id;

    if (digestAlreadyRun(runDate, repId, key)) {
      insertLog({
        runDate,
        ruleType: RULE.DIGEST,
        entityType: 'rules',
        entityId: key,
        repId,
        status: STATUS.SKIPPED_DEDUPE,
        detail: { reason: `a ${key} digest was already recorded for this rep today`, rules: activeRules, counts: digest.counts },
      });
      results.push({ rep: digest.rep, status: STATUS.SKIPPED_DEDUPE, channels: [], counts: digest.counts, rules: activeRules });
      continue;
    }

    const eligible = wanted.filter((c) => digest.rep.channels.includes(c));
    if (!eligible.length) {
      insertLog({
        runDate,
        ruleType: RULE.DIGEST,
        entityType: 'rules',
        entityId: key,
        repId,
        status: STATUS.SKIPPED,
        detail: { reason: 'no delivery channel enabled for this rep', rules: activeRules, counts: digest.counts },
      });
      results.push({ rep: digest.rep, status: STATUS.SKIPPED, channels: [], counts: digest.counts, rules: activeRules });
      continue;
    }

    // written BEFORE the send: a crash between here and the update leaves a
    // 'pending' row, which still blocks a second send on restart.
    const digestRowId = insertLog({
      runDate,
      ruleType: RULE.DIGEST,
      entityType: 'rules',
      entityId: key,
      repId,
      channel: eligible.join(','),
      status: STATUS.PENDING,
      detail: { counts: digest.counts, subject: digest.subject, rules: activeRules },
    });

    const perChannel = [];
    for (const channel of eligible) {
      try {
        const info = await registry[channel](digest);
        perChannel.push({ channel, status: STATUS.SENT, info: info || null });
      } catch (err) {
        logger.error({ err: err.message, rep: repId, channel, runDate }, 'digest send failed');
        perChannel.push({ channel, status: STATUS.FAILED, error: err.message });
      }
    }

    const anySent = perChannel.some((c) => c.status === STATUS.SENT);
    const digestStatus = anySent ? STATUS.SENT : STATUS.FAILED;
    updateLogStatus(digestRowId, digestStatus, {
      counts: digest.counts,
      subject: digest.subject,
      rules: activeRules,
      channels: perChannel.map((c) => ({ channel: c.channel, status: c.status, error: c.error || null })),
    });

    // every item, once per channel, carrying that channel's outcome
    const logItems = getDb().transaction(() => {
      for (const c of perChannel) {
        for (const item of digest.items) {
          insertLog({
            runDate,
            ruleType: item.rule_type,
            entityType: item.entity_type,
            entityId: item.entity_id,
            repId,
            channel: c.channel,
            status: c.status,
            detail: c.status === STATUS.FAILED ? { ...item.detail, error: c.error } : item.detail,
          });
        }
      }
    });
    logItems();

    results.push({
      rep: digest.rep,
      status: digestStatus,
      channels: perChannel,
      counts: digest.counts,
      items: digest.items.length,
      rules: activeRules,
    });
  }

  logger.info(
    {
      runDate,
      rules: activeRules,
      digests: evaluation.digests.length,
      sent: results.filter((r) => r.status === STATUS.SENT).length,
      failed: results.filter((r) => r.status === STATUS.FAILED).length,
      skipped: results.filter((r) => r.status.startsWith('skipped')).length,
    },
    'reminder digests processed'
  );

  return { ...evaluation, dryRun: false, channels: wanted, results };
}

function dryResult(digest, channels, key = ALL_RULES_KEY) {
  const eligible = channels.filter((c) => digest.rep.channels.includes(c));
  return {
    rep: digest.rep,
    status: eligible.length ? 'would_send' : STATUS.SKIPPED,
    wouldDedupe: digestAlreadyRun(digest.runDate, digest.rep.id, key),
    channels: eligible,
    counts: digest.counts,
    items: digest.items.length,
  };
}

// ---------------------------------------------------------------------------
// log reads (routes + dashboard)
// ---------------------------------------------------------------------------

const LOG_SELECT = `
  SELECT r.id, r.run_date, r.rule_type, r.entity_type, r.entity_id, r.salesperson_id,
         s.name AS rep_name, r.channel, r.status, r.detail, r.created_at
    FROM reminders_log r
    LEFT JOIN salespersons s ON s.zoho_salesperson_id = r.salesperson_id`;

function parseDetail(row) {
  if (!row) return row;
  let detail = null;
  if (row.detail) {
    try {
      detail = JSON.parse(row.detail);
    } catch (_err) {
      detail = { text: row.detail };
    }
  }
  return { ...row, detail, label: (detail && detail.label) || null, error: (detail && detail.error) || null };
}

function listLog({ date = null, rep = null, ruleType = null, status = null, limit = 50, offset = 0 } = {}) {
  const where = [];
  const params = { limit, offset };
  if (date) {
    where.push('r.run_date = @date');
    params.date = date;
  }
  if (rep) {
    where.push('r.salesperson_id = @rep');
    params.rep = rep;
  }
  if (ruleType) {
    where.push('r.rule_type = @ruleType');
    params.ruleType = ruleType;
  }
  if (status) {
    where.push('r.status = @status');
    params.status = status;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = getDb()
    .prepare(`${LOG_SELECT} ${clause} ORDER BY r.created_at DESC, r.id DESC LIMIT @limit OFFSET @offset`)
    .all(params)
    .map(parseDetail);
  const total = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM reminders_log r ${clause}`)
    .get(params).n;

  const counts = getDb()
    .prepare(`SELECT r.status, COUNT(*) AS n FROM reminders_log r ${clause} GROUP BY r.status`)
    .all(params)
    .reduce((acc, r) => ({ ...acc, [r.status]: r.n }), {});

  return { rows, total: Number(total || 0), counts };
}

/** Dates that have any log rows — the date picker's shortcut list. */
function logDates(limit = 30) {
  return getDb()
    .prepare('SELECT run_date, COUNT(*) AS n FROM reminders_log GROUP BY run_date ORDER BY run_date DESC LIMIT ?')
    .all(limit);
}

/**
 * Per-rep digest outcome for today and yesterday — the dashboard widget.
 * A rep may have several `digest` rows for one day (a real send plus later
 * deduped "send now" presses); the meaningful one wins.
 */
const STATUS_RANK = { sent: 4, failed: 3, pending: 2, skipped: 1, skipped_dedupe: 0 };

function digestStatus({ now = new Date(), date = null } = {}) {
  const today = date || todayIso(now);
  const yesterday = addDays(today, -1);
  const reps = digestReps();

  const rows = getDb()
    .prepare(
      `SELECT run_date, salesperson_id, channel, status, detail, created_at
         FROM reminders_log
        WHERE rule_type = 'digest' AND run_date IN (?, ?)
        ORDER BY created_at ASC, id ASC`
    )
    .all(today, yesterday)
    .map(parseDetail);

  const build = (day) => {
    const best = new Map();
    for (const row of rows.filter((r) => r.run_date === day)) {
      const current = best.get(row.salesperson_id);
      if (!current || (STATUS_RANK[row.status] ?? 0) >= (STATUS_RANK[current.status] ?? 0)) best.set(row.salesperson_id, row);
    }
    const repRows = reps.map((rep) => {
      const row = best.get(rep.id);
      const channels = row && row.detail && Array.isArray(row.detail.channels) ? row.detail.channels : [];
      return {
        rep_id: rep.id,
        rep_name: rep.name,
        email: rep.email,
        notify_email: rep.notify_email,
        notify_whatsapp: rep.notify_whatsapp,
        whatsapp_number: rep.whatsapp_number,
        channels,
        status: row ? row.status : 'none',
        channel: row ? row.channel : null,
        at: row ? row.created_at : null,
        subject: row && row.detail ? row.detail.subject || null : null,
        counts: row && row.detail ? row.detail.counts || null : null,
        error:
          row && row.detail && Array.isArray(row.detail.channels)
            ? row.detail.channels.filter((c) => c.error).map((c) => `${c.channel}: ${c.error}`).join('; ') || null
            : (row && row.detail && row.detail.reason) || null,
      };
    });
    const waChannel = (rep) => rep.channels.find((c) => c.channel === 'whatsapp') || null;
    return {
      date: day,
      reps: repRows,
      sent: repRows.filter((r) => r.status === 'sent').length,
      failed: repRows.filter((r) => r.status === 'failed').length,
      skipped: repRows.filter((r) => String(r.status).startsWith('skipped')).length,
      none: repRows.filter((r) => r.status === 'none').length,
      whatsappSent: repRows.filter((r) => (waChannel(r) || {}).status === 'sent').length,
      // the banner trigger: a digest went out while the session was down
      whatsappDown: repRows.some((r) => (waChannel(r) || {}).error === whatsapp.REASON.SESSION_DOWN),
    };
  };

  return {
    today: build(today),
    yesterday: build(yesterday),
    sendTime: String(config.getSetting('digest_send_time', '09:00')),
    whatsapp: whatsapp.getStatus({ includeQr: false }),
  };
}

module.exports = {
  RULE,
  RULE_KEYS,
  ALL_RULES_KEY,
  STATUS,
  CHANNELS,
  automaticRules,
  normalizeRules,
  rulesKey,
  DORMANT_MAX_PER_DIGEST,
  DORMANT_SUPPRESS_DAYS,
  addDays,
  daysBetween,
  fmtDate,
  inr,
  settingsSnapshot,
  digestReps,
  overdueRule,
  chequeRule,
  dormantRule,
  focusRule,
  renderText,
  renderHtml,
  evaluate,
  run,
  defaultSenders,
  digestAlreadyRun,
  listLog,
  logDates,
  digestStatus,
};
