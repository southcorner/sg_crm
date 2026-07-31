import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import api from '../api.js';
import { inr, inr0, fmtDate, num, timeAgo } from '../format.js';
import { Card, KpiCard, Loading, ErrorBox, EmptyRow, StatusChip, ProgressBar } from '../components/ui.jsx';
import { seriesColor } from '../charts.js';

export default function Dashboard() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get('/dashboard'),
    refetchInterval: 60000,
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;

  const k = data.kpis;
  const growth =
    k.lastMonthInvoiced.amount > 0
      ? Math.round(((k.mtdInvoiced.amount - k.lastMonthInvoiced.amount) / k.lastMonthInvoiced.amount) * 100)
      : null;

  return (
    <div className="page">
      <header className="page-header">
        <h1>Dashboard</h1>
        <p className="page-sub">Live figures from the last Zoho Books sync.</p>
      </header>

      {!data.sync.connected ? (
        <div className="banner warn">
          Zoho Books is not connected yet — <Link to="/settings">connect it in Settings</Link> to start syncing.
        </div>
      ) : null}

      <WhatsAppBanner whatsapp={data.whatsapp} reminders={data.reminders} />

      {data.sync.lineItems.pending > 0 ? (
        <div className="banner info">
          Invoice line items: {num(data.sync.lineItems.synced)} of {num(data.sync.lineItems.total)} invoices
          backfilled · {num(data.sync.lineItems.pending)} pending.
        </div>
      ) : null}

      <div className="kpi-row">
        <KpiCard
          label="Customers"
          value={num(k.customers.total)}
          sub={`${num(k.customers.active)} active · ${num(k.customers.withOutstanding)} owe money`}
        />
        <KpiCard
          label="Invoiced this month"
          value={inr0(k.mtdInvoiced.amount)}
          sub={
            growth === null
              ? `${num(k.mtdInvoiced.count)} invoices`
              : `${num(k.mtdInvoiced.count)} invoices · ${growth >= 0 ? '+' : ''}${growth}% vs last month`
          }
        />
        <KpiCard
          label="Total outstanding"
          value={inr0(k.outstanding.amount)}
          sub={`${num(k.outstanding.count)} open invoices`}
          tone={k.outstanding.amount > 0 ? 'due' : ''}
        />
        <KpiCard
          label="Overdue"
          value={inr0(k.overdue.amount)}
          sub={`${num(k.overdue.count)} invoices past due date`}
          tone={k.overdue.count > 0 ? 'bad' : ''}
        />
        <KpiCard
          label="Payments this month"
          value={inr0(k.mtdPayments.amount)}
          sub={`${num(k.mtdPayments.count)} payments`}
        />
      </div>

      {/* phase 3 — the CRM's own workflow queues */}
      <div className="kpi-row">
        <Link className="kpi-link" to="/cheques">
          <KpiCard
            label="Pending cheques"
            value={inr0(k.cheques.pending.amount)}
            sub={`${num(k.cheques.pending.count)} cheques awaiting deposit${
              k.cheques.pastDue.count ? ` · ${num(k.cheques.pastDue.count)} past their date` : ''
            }`}
            tone={k.cheques.pastDue.count > 0 ? 'bad' : ''}
          />
        </Link>
        <Link className="kpi-link" to="/cheques">
          <KpiCard
            label="Depositing in 7 days"
            value={inr0(k.cheques.next7.amount)}
            sub={`${num(k.cheques.next7.count)} cheques by ${fmtDate(k.cheques.next7.horizon)}`}
            tone={k.cheques.next7.count > 0 ? 'due' : ''}
          />
        </Link>
        <Link className="kpi-link" to="/dormant">
          <KpiCard
            label="Dormant customers"
            value={num(k.dormant.count)}
            sub={`no invoice since ${fmtDate(k.dormant.threshold)} (${k.dormant.months}m) · ${inr0(
              k.dormant.outstanding
            )} owed`}
          />
        </Link>
        <Link className="kpi-link" to="/focus">
          <KpiCard
            label="Focus plan open"
            value={num(k.focus.open)}
            sub={`${num(k.focus.total)} customer(s) planned for ${k.focus.month}`}
          />
        </Link>
      </div>

      <MtdBrands data={data.mtdBrands} />

      <DigestStatus data={data.reminders} />

      <div className="two-col">
        <Card title="Top outstanding customers">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Last invoice</th>
                  <th className="right">Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {data.topOutstanding.length ? (
                  data.topOutstanding.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <Link className="link" to={`/customers/${c.id}`}>
                          {c.contact_name}
                        </Link>
                      </td>
                      <td>{fmtDate(c.last_invoice_date)}</td>
                      <td className="right money-due">{inr(c.outstanding_receivable)}</td>
                    </tr>
                  ))
                ) : (
                  <EmptyRow colSpan={3}>Nothing outstanding.</EmptyRow>
                )}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Recent invoices">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Customer</th>
                  <th>Date</th>
                  <th className="right">Total</th>
                </tr>
              </thead>
              <tbody>
                {data.recentInvoices.length ? (
                  data.recentInvoices.map((inv) => (
                    <tr key={inv.id}>
                      <td>
                        <Link className="link" to={`/invoices/${inv.id}`}>
                          {inv.invoice_number}
                        </Link>
                      </td>
                      <td>{inv.customer_name}</td>
                      <td>{fmtDate(inv.invoice_date)}</td>
                      <td className="right">{inr(inv.total)}</td>
                    </tr>
                  ))
                ) : (
                  <EmptyRow colSpan={4}>No invoices synced yet.</EmptyRow>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <Card
        title="Sync status"
        actions={
          <Link className="btn ghost small" to="/settings">
            Open settings
          </Link>
        }
      >
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Entity</th>
                <th>Last run</th>
                <th>Status</th>
                <th className="right">Rows</th>
              </tr>
            </thead>
            <tbody>
              {data.sync.entities.map((e) => (
                <tr key={e.entity}>
                  <td>{e.entity.replace(/_/g, ' ')}</td>
                  <td>{e.lastRunAt ? timeAgo(e.lastRunAt) : 'never'}</td>
                  <td>
                    <StatusChip value={e.lastStatus || 'never run'} />
                  </td>
                  <td className="right">{num(e.rowCount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="backfill-block">
          <ProgressBar
            value={data.sync.apiCalls.used}
            max={data.sync.apiCalls.budget}
            label={`${num(data.sync.apiCalls.used)} / ${num(data.sync.apiCalls.budget)} Zoho API calls today`}
          />
        </div>
      </Card>
    </div>
  );
}

/**
 * The one thing an admin must be told about WhatsApp on the dashboard: the
 * session needs a human with a phone. Silent while the channel is off (the
 * default) or healthy — a dashboard that always shows a warning teaches people
 * to ignore warnings.
 */
function WhatsAppBanner({ whatsapp, reminders }) {
  if (!whatsapp || !whatsapp.enabled) return null;
  const missedDigest = Boolean(reminders?.today?.whatsappDown || reminders?.yesterday?.whatsappDown);
  if (whatsapp.ready && !missedDigest) return null;

  if (whatsapp.state === 'qr_pending') {
    return (
      <div className="banner warn">
        WhatsApp session down — scan the QR code in <Link to="/settings">Settings → WhatsApp</Link> to link the phone
        again. Digests are going out by email only.
      </div>
    );
  }

  return (
    <div className="banner warn">
      WhatsApp session down ({whatsapp.state}
      {whatsapp.lastError ? `: ${whatsapp.lastError}` : ''}) — reconnecting automatically; if it does not come back,
      scan the QR in <Link to="/settings">Settings → WhatsApp</Link>.
      {missedDigest ? ' A digest already went out email-only while the session was down.' : ''}
    </div>
  );
}

const DIGEST_TONE = {
  sent: 'ok',
  failed: 'bad',
  pending: 'info',
  skipped: 'muted',
  skipped_dedupe: 'muted',
  none: 'muted',
};

const DIGEST_LABEL = {
  sent: 'Sent',
  failed: 'Failed',
  pending: 'In flight',
  skipped: 'Skipped',
  skipped_dedupe: 'Deduped',
  none: 'Nothing to send',
};

/**
 * Who actually got their digest. "Nothing to send" is the normal state for a rep
 * with no overdue, no cheque and no dormant customer — it is deliberately not
 * shown as a failure.
 */
function DigestStatus({ data }) {
  if (!data) return null;
  const days = [
    { key: 'today', label: 'Today', day: data.today },
    { key: 'yesterday', label: 'Yesterday', day: data.yesterday },
  ];

  return (
    <Card
      title="Digest delivery"
      actions={
        <Link className="btn ghost small" to="/reminders">
          Reminder log
        </Link>
      }
    >
      <p className="muted-text">Digests go out Mon–Sat at {data.sendTime}.</p>
      <div className="digest-status">
        {days.map(({ key, label, day }) => (
          <div key={key} className="digest-day">
            <h3>
              {label} · {fmtDate(day.date)} — {day.sent} sent
              {day.failed ? `, ${day.failed} failed` : ''}
              {day.skipped ? `, ${day.skipped} skipped` : ''}
            </h3>
            <div className="digest-day-rows">
              {day.reps.length ? (
                day.reps.map((rep) => (
                  <div key={rep.rep_id} className={`digest-rep-row ${rep.status === 'failed' ? 'bad' : ''}`}>
                    <span className="name" title={rep.email || ''}>
                      {rep.rep_name}
                    </span>
                    {rep.channels?.length ? (
                      <span className="when">
                        {rep.channels.map((c) => (
                          <span
                            key={c.channel}
                            className={`channel-chip ${c.channel} ${c.status}`}
                            title={c.error ? `${c.channel}: ${c.error}` : `${c.channel}: ${c.status}`}
                          >
                            {c.channel}
                            {c.status === 'failed' ? ' ✕' : ''}
                          </span>
                        ))}
                      </span>
                    ) : rep.channel ? (
                      <span className="when">{rep.channel}</span>
                    ) : null}
                    <span className="when">{rep.at ? timeAgo(rep.at) : ''}</span>
                    <span className={`chip ${DIGEST_TONE[rep.status] || 'muted'}`}>
                      {DIGEST_LABEL[rep.status] || rep.status}
                    </span>
                  </div>
                ))
              ) : (
                <p className="muted-text">No active reps configured.</p>
              )}
            </div>
            {day.reps.some((r) => r.error) ? (
              <div className="banner warn">
                {day.reps
                  .filter((r) => r.error)
                  .map((r) => `${r.rep_name}: ${r.error}`)
                  .join(' · ')}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </Card>
  );
}

/**
 * Month-to-date sales split by brand. Derived from invoice line items, so
 * invoices still waiting on their line-item sync are called out rather than
 * silently dragging the split down.
 */
function MtdBrands({ data }) {
  if (!data) return null;
  const brands = data.brands || [];
  const total = data.total || 0;

  return (
    <Card
      title="This month by brand"
      actions={
        <Link className="btn ghost small" to="/performance">
          Performance
        </Link>
      }
    >
      {brands.length ? (
        <>
          <div className="brand-bar" role="img" aria-label="Month-to-date sales split by brand">
            {brands.map((b, i) => (
              <span
                key={b.brand_id ?? 'none'}
                className="brand-bar-seg"
                style={{ width: `${total > 0 ? (b.total / total) * 100 : 0}%`, background: seriesColor(i) }}
                title={`${b.brand_name}: ${inr(b.total)}`}
              />
            ))}
          </div>
          <div className="brand-legend">
            {brands.map((b, i) => (
              <div key={b.brand_id ?? 'none'} className="brand-legend-item">
                <span className="series-dot" style={{ background: seriesColor(i) }} />
                <span className="brand-legend-name">{b.brand_name}</span>
                <span className="brand-legend-value">{inr0(b.total)}</span>
                <span className="brand-legend-pct">{total > 0 ? Math.round((b.total / total) * 100) : 0}%</span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="muted-text">
          No brand-attributed sales this month yet. Brand figures need synced invoice line items and at least one
          mapped item — set the rules up on <Link className="link" to="/brands">Brands</Link>.
        </p>
      )}

      {data.pendingInvoices ? (
        <div className="banner warn">
          {num(data.pendingInvoices)} invoice(s) worth {inr0(data.pendingAmount)} are pending line-item sync and are
          not in this split.
        </div>
      ) : null}
    </Card>
  );
}
