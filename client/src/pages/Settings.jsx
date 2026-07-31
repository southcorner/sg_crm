import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import api from '../api.js';
import { fmtDateTime, timeAgo, num, titleCase } from '../format.js';
import { Card, Loading, ErrorBox, StatusChip, ProgressBar, Tabs } from '../components/ui.jsx';

const ENTITY_LABELS = {
  salespersons: 'Salespersons',
  items: 'Items',
  customers: 'Customers',
  invoices: 'Invoices',
  payments: 'Payments',
  invoice_details: 'Invoice line items',
};

export default function Settings() {
  const [tab, setTab] = useState('zoho');

  return (
    <div className="page">
      <header className="page-header">
        <h1>Settings</h1>
        <p className="page-sub">Zoho connection, sync control and the daily reminder digest. WhatsApp lands in phase 5.</p>
      </header>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'zoho', label: 'Zoho' },
          { key: 'reminders', label: 'Reminders' },
          { key: 'whatsapp', label: 'WhatsApp' },
          { key: 'account', label: 'Account' },
        ]}
      />

      {tab === 'zoho' && <ZohoTab />}
      {tab === 'whatsapp' && (
        <Card title="WhatsApp">
          <p className="muted-text">The WhatsApp session and QR pairing land in phase 5.</p>
        </Card>
      )}
      {tab === 'reminders' && <RemindersTab />}
      {tab === 'account' && (
        <Card title="Account">
          <p className="muted-text">Password change lands with the reminder-engine phase.</p>
        </Card>
      )}
    </div>
  );
}

/**
 * Everything the reminder engine reads: when the digest goes out, the four rule
 * windows, and the mail server that carries it. Saving an smtp_* key drops the
 * cached transport server-side and saving the send time re-registers the cron
 * job, so nothing here needs a restart.
 */
function RemindersTab() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['settings'], queryFn: () => api.get('/settings') });
  const [draft, setDraft] = useState(null);
  const [testTo, setTestTo] = useState('');

  const save = useMutation({
    mutationFn: (body) => api.put('/settings', body),
    onSuccess: (res) => {
      setDraft(null);
      queryClient.setQueryData(['settings'], res);
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      queryClient.invalidateQueries({ queryKey: ['dormant'] });
      queryClient.invalidateQueries({ queryKey: ['cheques'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['reminders-status'] });
    },
  });

  const testEmail = useMutation({ mutationFn: (to) => api.post('/settings/test-email', { to }) });

  if (isLoading) return <Loading />;

  const settings = data?.settings || {};
  const smtp = data?.smtp || {};
  const cron = data?.cron || {};
  const value = (key) => (draft && draft[key] !== undefined ? draft[key] : String(settings[key] ?? ''));
  const checked = (key) =>
    draft && draft[key] !== undefined ? Boolean(draft[key]) : Boolean(settings[key]);
  const set = (key, v) => setDraft((d) => ({ ...(d || {}), [key]: v }));

  return (
    <>
      <ErrorBox error={error || save.error} />

      <Card title="Digest schedule and rules">
        <p className="muted-text">
          {cron.started
            ? `The digest job is registered for ${cron.sendTime}, Monday to Saturday.`
            : 'Scheduled jobs are not running in this process — digests can still be sent by hand from the Reminders page.'}
        </p>
        <form
          className="stack-form wide"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({
              digest_send_time: value('digest_send_time'),
              dormant_months: Number(value('dormant_months')),
              cheque_lead_days: Number(value('cheque_lead_days')),
              overdue_min_days: Number(value('overdue_min_days')),
              overdue_min_amount: Number(value('overdue_min_amount')),
              overdue_resend_days: Number(value('overdue_resend_days')),
            });
          }}
        >
          <div className="settings-grid">
            <label>
              Digest send time
              <input type="time" value={value('digest_send_time')} onChange={(e) => set('digest_send_time', e.target.value)} />
              <span className="hint">Mon–Sat. Changing this re-registers the job immediately.</span>
            </label>
            <label>
              Overdue after (days past due)
              <input
                type="number"
                min="0"
                max="365"
                step="1"
                value={value('overdue_min_days')}
                onChange={(e) => set('overdue_min_days', e.target.value)}
              />
              <span className="hint">An invoice is chased once its due date is further back than this.</span>
            </label>
            <label>
              Ignore balances under (₹)
              <input
                type="number"
                min="0"
                step="100"
                value={value('overdue_min_amount')}
                onChange={(e) => set('overdue_min_amount', e.target.value)}
              />
              <span className="hint">0 = chase everything. Applied per invoice.</span>
            </label>
            <label>
              Re-nag the same invoice after (days)
              <input
                type="number"
                min="1"
                max="365"
                step="1"
                value={value('overdue_resend_days')}
                onChange={(e) => set('overdue_resend_days', e.target.value)}
              />
              <span className="hint">An invoice stays out of the digest for this long after it was last sent.</span>
            </label>
            <label>
              Dormant after (months)
              <input
                type="number"
                min="1"
                max="120"
                step="1"
                value={value('dormant_months')}
                onChange={(e) => set('dormant_months', e.target.value)}
              />
              <span className="hint">
                Drives the Dormant page and the 😴 section — max 10 per digest, each customer at most once a fortnight.
              </span>
            </label>
            <label>
              Cheque reminder lead time (days)
              <input
                type="number"
                min="0"
                max="60"
                step="1"
                value={value('cheque_lead_days')}
                onChange={(e) => set('cheque_lead_days', e.target.value)}
              />
              <span className="hint">A pending cheque is announced exactly this many days before its deposit date.</span>
            </label>
          </div>
          <div className="form-row">
            <button type="submit" className="btn" disabled={save.isPending || !draft}>
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
            {save.isSuccess && !draft ? <span className="form-ok">Saved.</span> : null}
          </div>
        </form>
      </Card>

      <Card
        title="Mail server (SMTP)"
        actions={<StatusChip value={smtp.configured ? 'configured' : 'not configured'} tone={smtp.configured ? 'ok' : 'warn'} />}
      >
        {smtp.testTransport ? (
          <p className="muted-text">
            <strong>SMTP_TRANSPORT={smtp.testTransport}</strong> is set — mail is captured locally instead of being
            delivered. Unset it in .env for real sending.
          </p>
        ) : null}
        <form
          className="stack-form wide"
          onSubmit={(e) => {
            e.preventDefault();
            const body = {
              smtp_host: value('smtp_host'),
              smtp_port: Number(value('smtp_port')),
              smtp_secure: checked('smtp_secure'),
              smtp_user: value('smtp_user'),
              smtp_from: value('smtp_from'),
            };
            if (draft && draft.smtp_pass) body.smtp_pass = draft.smtp_pass;
            save.mutate(body);
          }}
        >
          <div className="settings-grid">
            <label>
              Host
              <input
                type="text"
                autoComplete="off"
                placeholder="smtp.zoho.in"
                value={value('smtp_host')}
                onChange={(e) => set('smtp_host', e.target.value)}
              />
            </label>
            <label>
              Port
              <input type="number" min="1" max="65535" value={value('smtp_port')} onChange={(e) => set('smtp_port', e.target.value)} />
              <span className="hint">465 = implicit TLS, 587 = STARTTLS.</span>
            </label>
            <label className="checkbox-field">
              <input type="checkbox" checked={checked('smtp_secure')} onChange={(e) => set('smtp_secure', e.target.checked)} />
              Use implicit TLS (port 465)
            </label>
            <label>
              Username
              <input
                type="text"
                autoComplete="off"
                value={value('smtp_user')}
                onChange={(e) => set('smtp_user', e.target.value)}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete="new-password"
                placeholder={smtp.passSet ? '•••••••• (stored)' : ''}
                value={(draft && draft.smtp_pass) || ''}
                onChange={(e) => set('smtp_pass', e.target.value)}
              />
              <span className="hint">Write-only — it is never sent back to the browser.</span>
            </label>
            <label>
              From address
              <input
                type="text"
                autoComplete="off"
                placeholder="SG CRM &lt;crm@example.in&gt;"
                value={value('smtp_from')}
                onChange={(e) => set('smtp_from', e.target.value)}
              />
            </label>
          </div>
          <div className="form-row">
            <button type="submit" className="btn" disabled={save.isPending || !draft}>
              {save.isPending ? 'Saving…' : 'Save SMTP settings'}
            </button>
          </div>
        </form>

        <div className="backfill-block">
          <h3>Send a test email</h3>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (testTo.trim()) testEmail.mutate(testTo.trim());
            }}
          >
            <input
              type="email"
              placeholder="you@example.in"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              required
            />
            <button type="submit" className="btn ghost" disabled={testEmail.isPending}>
              {testEmail.isPending ? 'Sending…' : 'Send test email'}
            </button>
            {testEmail.isError ? <span className="form-error">{testEmail.error.message}</span> : null}
            {testEmail.isSuccess ? (
              <span className="form-ok">
                Sent to {testEmail.data.to}
                {testEmail.data.messageId ? ` (${testEmail.data.messageId})` : ''}.
              </span>
            ) : null}
          </form>
          <p className="muted-text">
            Save the settings first — the test uses whatever is stored. Reps receive their digest at their CRM email,
            falling back to the address Zoho has; set those on <Link className="link" to="/reps">Reps</Link>.
          </p>
        </div>
      </Card>
    </>
  );
}

function ZohoTab() {
  const queryClient = useQueryClient();

  const statusQuery = useQuery({ queryKey: ['zoho-status'], queryFn: () => api.get('/zoho/status') });
  const syncQuery = useQuery({
    queryKey: ['sync-status'],
    queryFn: () => api.get('/sync/status'),
    refetchInterval: (query) => (query.state.data?.running ? 2000 : 15000),
  });

  const connect = useMutation({
    mutationFn: (body) => api.post('/zoho/connect', body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['zoho-status'] });
      queryClient.invalidateQueries({ queryKey: ['sync-status'] });
    },
  });

  const disconnect = useMutation({
    mutationFn: () => api.post('/zoho/disconnect'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['zoho-status'] }),
  });

  const runSync = useMutation({
    mutationFn: (entity) => api.post('/sync/run', entity ? { entity } : {}),
    onSuccess: () => {
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ['sync-status'] }), 400);
    },
  });

  const setBudget = useMutation({
    mutationFn: (budget) => api.put('/zoho/budget', { budget }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['zoho-status'] }),
  });

  const [form, setForm] = useState({ client_id: '', client_secret: '', grant_code: '' });
  const [budgetInput, setBudgetInput] = useState('');

  const status = statusQuery.data;
  const sync = syncQuery.data;
  const lineItems = sync?.lineItems || { total: 0, synced: 0, pending: 0 };
  const apiCalls = status?.apiCalls || sync?.apiCalls || { used: 0, budget: 2000, remaining: 0 };

  return (
    <>
      <Card title="Connection">
        {statusQuery.isLoading ? (
          <Loading />
        ) : (
          <>
            <div className="status-row">
              <StatusChip
                value={status?.connected ? 'connected' : 'not connected'}
                tone={status?.connected ? 'ok' : 'warn'}
              />
              {status?.connected ? (
                <span className="muted-text">
                  {status.organizationName || 'Organization'} · org id {status.organizationId} · connected{' '}
                  {fmtDateTime(status.connectedAt)}
                </span>
              ) : (
                <span className="muted-text">Paste a Self Client grant code below to connect.</span>
              )}
            </div>

            <div className="budget-block">
              <ProgressBar
                value={apiCalls.used}
                max={apiCalls.budget}
                label={`${num(apiCalls.used)} / ${num(apiCalls.budget)} API calls used today`}
              />
              <form
                className="inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const value = Number(budgetInput);
                  if (Number.isFinite(value) && value >= 50) setBudget.mutate(value);
                }}
              >
                <input
                  type="number"
                  min="50"
                  step="50"
                  placeholder={String(apiCalls.budget)}
                  value={budgetInput}
                  onChange={(e) => setBudgetInput(e.target.value)}
                />
                <button type="submit" className="btn ghost" disabled={setBudget.isPending}>
                  Update budget
                </button>
                {status?.connected ? (
                  <button
                    type="button"
                    className="btn danger ghost"
                    onClick={() => disconnect.mutate()}
                    disabled={disconnect.isPending}
                  >
                    Disconnect
                  </button>
                ) : null}
              </form>
            </div>
          </>
        )}
      </Card>

      <Card title={status?.connected ? 'Re-connect / rotate credentials' : 'Connect to Zoho Books'}>
        <p className="muted-text">
          Create a <strong>Self Client</strong> at{' '}
          <a className="link" href="https://api-console.zoho.in" target="_blank" rel="noreferrer">
            api-console.zoho.in
          </a>
          , generate a grant code for scope <code>ZohoBooks.fullaccess.all</code> and paste it here.{' '}
          <strong>The grant code expires 10 minutes after it is generated</strong> and can only be used once.
        </p>

        <form
          className="stack-form"
          onSubmit={(e) => {
            e.preventDefault();
            connect.mutate({
              grant_code: form.grant_code.trim(),
              ...(form.client_id.trim() ? { client_id: form.client_id.trim() } : {}),
              ...(form.client_secret.trim() ? { client_secret: form.client_secret.trim() } : {}),
            });
          }}
        >
          <label>
            Client ID
            <input
              type="text"
              autoComplete="off"
              placeholder={status?.clientIdMasked || '1000.XXXXXXXXXXXXXXXX'}
              value={form.client_id}
              onChange={(e) => setForm({ ...form, client_id: e.target.value })}
            />
          </label>
          <label>
            Client secret
            <input
              type="password"
              autoComplete="off"
              placeholder={status?.hasCredentials ? '•••••••• (stored)' : ''}
              value={form.client_secret}
              onChange={(e) => setForm({ ...form, client_secret: e.target.value })}
            />
          </label>
          <label>
            Grant code
            <input
              type="text"
              autoComplete="off"
              placeholder="1000.abc123…"
              value={form.grant_code}
              onChange={(e) => setForm({ ...form, grant_code: e.target.value })}
              required
            />
          </label>
          <div className="form-row">
            <button type="submit" className="btn" disabled={connect.isPending}>
              {connect.isPending ? 'Connecting…' : 'Connect'}
            </button>
            {connect.isError ? <span className="form-error">{connect.error.message}</span> : null}
            {connect.isSuccess ? <span className="form-ok">Connected.</span> : null}
          </div>
        </form>
      </Card>

      <Card
        title="Sync"
        actions={
          <div className="panel-actions">
            {sync?.running ? <StatusChip value="running" tone="info" /> : null}
            <button
              type="button"
              className="btn"
              onClick={() => runSync.mutate(null)}
              disabled={runSync.isPending || sync?.running || !status?.connected}
            >
              Sync now
            </button>
          </div>
        }
      >
        <ErrorBox error={syncQuery.error} />
        {runSync.isError ? <div className="state-msg error">{runSync.error.message}</div> : null}
        {!status?.connected ? (
          <p className="muted-text">Connect Zoho above before running a sync.</p>
        ) : null}

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Entity</th>
                <th>Last run</th>
                <th>Status</th>
                <th>Cursor</th>
                <th className="right">Rows in CRM</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(sync?.entities || []).map((e) => (
                <tr key={e.entity}>
                  <td>{ENTITY_LABELS[e.entity] || titleCase(e.entity)}</td>
                  <td title={e.lastRunAt || ''}>{e.lastRunAt ? timeAgo(e.lastRunAt) : 'never'}</td>
                  <td>
                    <StatusChip value={e.lastStatus || 'never run'} />
                    {e.lastError ? <div className="sub error-text">{e.lastError}</div> : null}
                  </td>
                  <td className="mono">{e.cursor || '—'}</td>
                  <td className="right">{num(e.rowCount)}</td>
                  <td className="right">
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() => runSync.mutate(e.entity)}
                      disabled={runSync.isPending || sync?.running || !status?.connected}
                    >
                      Sync
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="backfill-block">
          <h3>Invoice line-item backfill</h3>
          <ProgressBar
            value={lineItems.synced}
            max={lineItems.total}
            label={`line items synced ${num(lineItems.synced)} of ${num(lineItems.total)} invoices${
              lineItems.pending ? ` · ${num(lineItems.pending)} pending` : ''
            }`}
          />
          <p className="muted-text">
            Every invoice needs its own API call for line items, so the first backfill can take a few days
            within the daily call budget. It resumes automatically on each sync, oldest invoices first.
          </p>
        </div>
      </Card>
    </>
  );
}
