import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import api from '../api.js';
import { fmtDateTime, num, qs, titleCase, inr0 } from '../format.js';
import { Card, Loading, ErrorBox, EmptyRow, Banner, StatusChip, Pagination, Select } from '../components/ui.jsx';

const RULE_LABEL = {
  digest: 'Digest',
  overdue: 'Overdue',
  cheque: 'Cheque due',
  dormant: 'Dormant',
  focus: 'Focus plan',
};

const STATUS_TONE = {
  sent: 'ok',
  failed: 'bad',
  pending: 'info',
  skipped: 'muted',
  skipped_dedupe: 'muted',
  would_send: 'info',
  none: 'muted',
};

/** Local YYYY-MM-DD — the server thinks in the same timezone. */
function todayIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default function Reminders() {
  const queryClient = useQueryClient();
  const [date, setDate] = useState(todayIso());
  const [rep, setRep] = useState('');
  const [ruleType, setRuleType] = useState('');
  const [page, setPage] = useState(1);
  const [preview, setPreview] = useState(null);
  const [confirming, setConfirming] = useState(false);

  const statusQuery = useQuery({ queryKey: ['reminders-status'], queryFn: () => api.get('/reminders/status') });

  const logQuery = useQuery({
    queryKey: ['reminders-log', date, rep, ruleType, page],
    queryFn: () => api.get(`/reminders/log${qs({ date, rep, rule_type: ruleType, page, per_page: 50 })}`),
    placeholderData: (prev) => prev,
  });

  const dryRun = useMutation({
    mutationFn: () => api.post('/reminders/run', { date, dry_run: true }),
    onSuccess: (res) => setPreview(res),
  });

  const sendNow = useMutation({
    mutationFn: () => api.post('/reminders/run', { date }),
    onSuccess: (res) => {
      setConfirming(false);
      setPreview(res);
      queryClient.invalidateQueries({ queryKey: ['reminders-log'] });
      queryClient.invalidateQueries({ queryKey: ['reminders-status'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  const log = logQuery.data;
  const reps = log?.reps || [];
  const smtp = statusQuery.data?.smtp;
  const cron = statusQuery.data?.cron;
  const whatsapp = statusQuery.data?.whatsapp;
  const isToday = date === todayIso();

  return (
    <div className="page">
      <header className="page-header">
        <h1>Reminders</h1>
        <p className="page-sub">
          One digest per rep per day. The engine dedupes on every level — an invoice is re-nagged only after the
          resend window, a cheque fires once per deposit date, and a rep can never be mailed twice in a day.
        </p>
      </header>

      {smtp && !smtp.configured ? (
        <Banner tone="warn">
          SMTP is not configured — digests cannot be delivered. Set the mail server in{' '}
          <Link to="/settings">Settings → Reminders</Link>.
        </Banner>
      ) : null}
      {whatsapp && whatsapp.enabled && !whatsapp.ready ? (
        <Banner tone="warn">
          WhatsApp session down ({whatsapp.state}) — digests go out by email only and every WhatsApp row below is
          logged as <code>session_down</code>. Scan the QR in <Link to="/settings">Settings → WhatsApp</Link>.
        </Banner>
      ) : null}
      {cron && cron.enabled === false ? (
        <Banner tone="warn">Scheduled jobs are disabled on this machine (ENABLE_CRON). Digests will only go out manually.</Banner>
      ) : null}
      {cron && cron.started ? (
        <Banner tone="info">
          The digest job runs Mon–Sat at <strong>{cron.sendTime}</strong> (cron <code>{cron.jobs?.[0]?.expr}</code>).
        </Banner>
      ) : null}

      <div className="filter-bar">
        <label className="date-field">
          Date
          <input
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              setPage(1);
              setPreview(null);
            }}
          />
        </label>
        <Select
          label="Rep"
          value={rep}
          allLabel="All reps"
          onChange={(v) => {
            setRep(v);
            setPage(1);
          }}
          options={reps.map((r) => ({ value: r.id, label: r.name }))}
        />
        <Select
          label="Rule"
          value={ruleType}
          allLabel="All rules"
          onChange={(v) => {
            setRuleType(v);
            setPage(1);
          }}
          options={(log?.ruleTypes || []).map((r) => ({ value: r, label: RULE_LABEL[r] || titleCase(r) }))}
        />
        <div className="spacer" />
        <button type="button" className="btn ghost" onClick={() => dryRun.mutate()} disabled={dryRun.isPending}>
          {dryRun.isPending ? 'Composing…' : `Preview ${isToday ? "today's" : "that day's"} digests`}
        </button>
        <button type="button" className="btn" onClick={() => setConfirming(true)} disabled={sendNow.isPending}>
          {sendNow.isPending ? 'Sending…' : 'Send now'}
        </button>
      </div>

      <ErrorBox error={logQuery.error || dryRun.error || sendNow.error} />

      {confirming ? (
        <Card title="Send the digests now?">
          <p className="muted-text">
            This runs the {date} digest immediately and emails every rep who has something outstanding.{' '}
            <strong>Dedupe still applies:</strong> reps who already got their digest for {date} are skipped, and items
            inside their resend window stay out. Nobody is mailed twice.
          </p>
          <div className="form-row">
            <button type="button" className="btn" onClick={() => sendNow.mutate()} disabled={sendNow.isPending}>
              {sendNow.isPending ? 'Sending…' : 'Yes, send'}
            </button>
            <button type="button" className="btn ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </Card>
      ) : null}

      {preview ? <PreviewPanel preview={preview} onClose={() => setPreview(null)} /> : null}

      {logQuery.isLoading && !log ? (
        <Loading />
      ) : (
        <Card
          title={`Reminder log · ${num(log?.total || 0)} row(s)`}
          actions={
            <div className="panel-actions">
              {Object.entries(log?.counts || {}).map(([status, n]) => (
                <span key={status} className={`chip ${STATUS_TONE[status] || 'muted'}`}>
                  {titleCase(status)} {n}
                </span>
              ))}
            </div>
          }
        >
          <div className="table-wrap">
            <table className="data-table reminder-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Rep</th>
                  <th>Rule</th>
                  <th>Entity</th>
                  <th>Channel</th>
                  <th>Status</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {log?.rows?.length ? (
                  log.rows.map((row) => (
                    <tr key={row.id} className={row.status === 'failed' ? 'row-past-due' : ''}>
                      <td className="nowrap">{fmtDateTime(row.created_at)}</td>
                      <td>{row.rep_name || '—'}</td>
                      <td>{RULE_LABEL[row.rule_type] || titleCase(row.rule_type)}</td>
                      <td>
                        {row.label || row.entity_id || '—'}
                        {row.entity_type ? <div className="sub">{row.entity_type.replace(/_/g, ' ')}</div> : null}
                      </td>
                      <td className="nowrap">
                        {row.channel
                          ? row.channel.split(',').map((c) => (
                              <span key={c} className={`channel-chip ${c} ${row.status}`}>
                                {c}
                              </span>
                            ))
                          : '—'}
                      </td>
                      <td>
                        <span className={`chip ${STATUS_TONE[row.status] || 'muted'}`}>{titleCase(row.status)}</span>
                      </td>
                      <td className="detail-cell">
                        {row.error ? <span className="error-text">{row.error}</span> : detailText(row)}
                      </td>
                    </tr>
                  ))
                ) : (
                  <EmptyRow colSpan={7}>
                    Nothing logged for {date}. Use “Preview” to see what a run would produce.
                  </EmptyRow>
                )}
              </tbody>
            </table>
          </div>
          <Pagination page={log?.page || 1} pages={log?.pages || 1} total={log?.total || 0} onPage={setPage} />
        </Card>
      )}
    </div>
  );
}

function detailText(row) {
  const d = row.detail;
  if (!d) return '—';
  if (row.rule_type === 'digest') {
    const c = d.counts || {};
    if (d.reason) return d.reason;
    return [
      c.overdue ? `${c.overdue} overdue` : null,
      c.cheques ? `${c.cheques} cheque(s)` : null,
      c.dormant ? `${c.dormant} dormant` : null,
      c.focus ? `${c.focus} focus` : null,
    ]
      .filter(Boolean)
      .join(' · ') || '—';
  }
  if (row.rule_type === 'overdue') return `${inr0(d.balance || 0)} · ${d.days_overdue} day(s) overdue`;
  if (row.rule_type === 'cheque') return `${inr0(d.amount || 0)} · deposits ${d.deposit_date}`;
  if (row.rule_type === 'dormant') return `last invoice ${d.last_invoice_date || '—'} (${d.months_dormant} mo)`;
  if (row.rule_type === 'focus') return d.note || '—';
  return '—';
}

/**
 * The composed digests. Shown for both a dry run and a real one — after a real
 * run the `results` carry what actually happened per rep.
 */
function PreviewPanel({ preview, onClose }) {
  const [open, setOpen] = useState(preview.digests?.[0]?.rep?.id || null);
  const resultFor = (repId) => (preview.results || []).find((r) => r.rep.id === repId);

  return (
    <Card
      title={`${preview.dryRun ? 'Preview' : 'Run'} · ${preview.runDate} · ${preview.digests.length} digest(s)`}
      actions={
        <button type="button" className="btn ghost small" onClick={onClose}>
          Close
        </button>
      }
    >
      {preview.dryRun ? (
        <p className="muted-text">Nothing was sent and nothing was logged — this is exactly what a real run would compose.</p>
      ) : null}

      <div className="stat-strip">
        <span>
          Overdue candidates <strong>{preview.stats.overdue.candidates}</strong> · suppressed{' '}
          <strong>{preview.stats.overdue.suppressed}</strong>
        </span>
        <span>
          Cheques <strong>{preview.stats.cheque.candidates}</strong> · suppressed{' '}
          <strong>{preview.stats.cheque.suppressed}</strong>
        </span>
        <span>
          Dormant <strong>{preview.stats.dormant.candidates}</strong> of {preview.stats.dormant.total} · cap{' '}
          {preview.stats.dormant.cap}
        </span>
        <span>
          Focus {preview.stats.focus.isMonday ? '(Monday)' : '(catch-up only)'} <strong>{preview.stats.focus.included}</strong>
        </span>
      </div>

      {preview.digests.length ? (
        <div className="digest-list">
          {preview.digests.map((d) => {
            const result = resultFor(d.rep.id);
            return (
              <div key={d.rep.id} className="digest-item">
                <button type="button" className="digest-head" onClick={() => setOpen(open === d.rep.id ? null : d.rep.id)}>
                  <span className="digest-rep">{d.rep.name}</span>
                  <span className="digest-to">{d.rep.email || 'no email address'}</span>
                  <span className="digest-counts">
                    {d.counts.overdue ? <span className="pill">{d.counts.overdue} overdue</span> : null}
                    {d.counts.cheques ? <span className="pill">{d.counts.cheques} cheque</span> : null}
                    {d.counts.dormant ? <span className="pill">{d.counts.dormant} dormant</span> : null}
                    {d.counts.focus ? <span className="pill">{d.counts.focus} focus</span> : null}
                  </span>
                  {result ? (
                    <span className={`chip ${STATUS_TONE[result.status] || 'muted'}`}>{titleCase(result.status)}</span>
                  ) : null}
                  {result?.wouldDedupe ? <span className="chip muted">already sent today</span> : null}
                  <span className="digest-toggle">{open === d.rep.id ? '▲' : '▼'}</span>
                </button>
                {open === d.rep.id ? (
                  <>
                    <div className="digest-subject">{d.subject}</div>
                    {d.text ? <pre className="digest-body">{d.text}</pre> : null}
                    {!d.text ? (
                      <p className="muted-text">
                        The rendered body is only returned for a preview — see the log rows above for what was sent.
                      </p>
                    ) : null}
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="muted-text">
          No rep has anything outstanding for {preview.runDate} — nobody would be mailed. That is the intended
          behaviour, not an error.
        </p>
      )}
    </Card>
  );
}
