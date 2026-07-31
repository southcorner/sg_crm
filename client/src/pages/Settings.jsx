import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import api from '../api.js';
import { fmtDateTime, timeAgo, num, titleCase } from '../format.js';
import { Card, Loading, ErrorBox, StatusChip, ProgressBar, Tabs, Banner } from '../components/ui.jsx';

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
        <p className="page-sub">Zoho connection, sync control, the daily reminder digest and the WhatsApp session.</p>
      </header>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'zoho', label: 'Zoho' },
          { key: 'reminders', label: 'Reminders' },
          { key: 'whatsapp', label: 'WhatsApp' },
          { key: 'account', label: 'Security' },
        ]}
      />

      {tab === 'zoho' && <ZohoTab />}
      {tab === 'whatsapp' && <WhatsAppTab />}
      {tab === 'reminders' && <RemindersTab />}
      {tab === 'account' && <SecurityTab />}
    </div>
  );
}

/**
 * The single admin account. There is no user management to build here — one
 * login, one password — so this tab is the password form plus the nag that
 * appears while the password is still the shipped default.
 */
function SecurityTab() {
  const queryClient = useQueryClient();
  const meQuery = useQuery({ queryKey: ['auth', 'me'], queryFn: () => api.get('/auth/me') });
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [localError, setLocalError] = useState(null);

  const change = useMutation({
    mutationFn: (body) => api.post('/auth/change-password', body),
    onSuccess: () => {
      setForm({ current: '', next: '', confirm: '' });
      setLocalError(null);
      queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
    },
  });

  const user = meQuery.data?.user;
  const mismatch = form.confirm.length > 0 && form.next !== form.confirm;

  return (
    <>
      {user?.password_is_default ? (
        <Banner tone="warn">
          This account is still using the default password <code>admin123</code>. Anyone who can reach this machine on
          the network can log in. Change it now.
        </Banner>
      ) : null}

      <Card title="Admin password">
        <p className="muted-text">
          One admin account, <strong>{user?.username || 'admin'}</strong>
          {user?.last_login_at ? ` · last login ${fmtDateTime(user.last_login_at)}` : ''}. Reps never log in — they
          only receive digests — so this is the only credential the CRM has.
        </p>

        <form
          className="stack-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (form.next !== form.confirm) {
              setLocalError('the two new passwords do not match');
              return;
            }
            if (form.next.length < 8) {
              setLocalError('the new password must be at least 8 characters');
              return;
            }
            setLocalError(null);
            change.mutate({ current_password: form.current, new_password: form.next });
          }}
        >
          <label>
            Current password
            <input
              type="password"
              autoComplete="current-password"
              value={form.current}
              onChange={(e) => setForm({ ...form, current: e.target.value })}
              required
            />
          </label>
          <label>
            New password
            <input
              type="password"
              autoComplete="new-password"
              value={form.next}
              onChange={(e) => setForm({ ...form, next: e.target.value })}
              minLength={8}
              required
            />
            <span className="hint">At least 8 characters. It is stored as a bcrypt hash, never in plain text.</span>
          </label>
          <label>
            Confirm new password
            <input
              type="password"
              autoComplete="new-password"
              value={form.confirm}
              onChange={(e) => setForm({ ...form, confirm: e.target.value })}
              required
            />
            {mismatch ? <span className="form-error">The two new passwords do not match.</span> : null}
          </label>
          <div className="form-row">
            <button type="submit" className="btn" disabled={change.isPending || mismatch || !form.current || !form.next}>
              {change.isPending ? 'Saving…' : 'Change password'}
            </button>
            {localError ? <span className="form-error">{localError}</span> : null}
            {change.isError ? <span className="form-error">{change.error.message}</span> : null}
            {change.isSuccess ? <span className="form-ok">Password changed. Your session stays signed in.</span> : null}
          </div>
        </form>

        <p className="muted-text">
          Forgotten it? There is no reset email. Stop the service, put a new <code>ADMIN_PASSWORD</code> in{' '}
          <code>.env</code>, delete the row in the <code>admin_user</code> table (or restore a backup) and restart —
          the server recreates the account on the next boot.
        </p>
      </Card>
    </>
  );
}

const WA_STATE = {
  disconnected: { label: 'Not running', tone: 'muted' },
  initializing: { label: 'Starting…', tone: 'info' },
  qr_pending: { label: 'Waiting for a scan', tone: 'warn' },
  authenticated: { label: 'Authenticated', tone: 'info' },
  ready: { label: 'Ready', tone: 'ok' },
};

/**
 * The WhatsApp session: a QR pairing, not an API key — so this tab is mostly a
 * window onto a state machine. It polls /api/whatsapp/status every 3 s while it
 * is open (and only while it is open), because the QR appears asynchronously
 * once the headless browser has booted and expires on its own.
 */
function WhatsAppTab() {
  const queryClient = useQueryClient();
  const [testNumber, setTestNumber] = useState('');
  const [confirmLogout, setConfirmLogout] = useState(false);

  const statusQuery = useQuery({
    queryKey: ['whatsapp-status'],
    queryFn: () => api.get('/whatsapp/status'),
    refetchInterval: 3000,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['whatsapp-status'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    queryClient.invalidateQueries({ queryKey: ['reminders-status'] });
  };

  const toggle = useMutation({
    mutationFn: (enabled) => api.post(`/whatsapp/${enabled ? 'enable' : 'disable'}`),
    onSuccess: (res) => {
      queryClient.setQueryData(['whatsapp-status'], res);
      invalidate();
    },
  });
  const restart = useMutation({ mutationFn: () => api.post('/whatsapp/restart'), onSuccess: invalidate });
  const logout = useMutation({
    mutationFn: () => api.post('/whatsapp/logout'),
    onSuccess: () => {
      setConfirmLogout(false);
      invalidate();
    },
  });
  const sendTest = useMutation({
    mutationFn: (number) => api.post('/whatsapp/test', number ? { number } : {}),
    onSuccess: invalidate,
  });

  const s = statusQuery.data;
  const state = s?.state || 'disconnected';
  const view = WA_STATE[state] || { label: state, tone: 'muted' };
  const enabled = Boolean(s?.enabled);

  return (
    <>
      <ErrorBox error={statusQuery.error || toggle.error || restart.error || logout.error} />

      <Card
        title="WhatsApp delivery"
        actions={
          <button
            type="button"
            className={enabled ? 'btn danger ghost' : 'btn'}
            onClick={() => toggle.mutate(!enabled)}
            disabled={toggle.isPending}
          >
            {toggle.isPending ? 'Working…' : enabled ? 'Disable WhatsApp' : 'Enable WhatsApp'}
          </button>
        }
      >
        <p className="muted-text">
          Digests can go out on WhatsApp as well as email. This uses <strong>whatsapp-web.js</strong>, an{' '}
          <strong>unofficial</strong> library that drives a real WhatsApp Web session in a headless browser — the same
          thing as keeping WhatsApp Web open on this machine. Please read the honest version before switching it on:
        </p>
        <ul className="honest-list">
          <li>
            <strong>Use a dedicated number.</strong> Pair a spare SIM, not the owner's personal phone.
          </li>
          <li>
            <strong>There is a ban risk.</strong> Automation is against WhatsApp's terms. The CRM keeps volume tiny
            (one digest per rep per day, sent one at a time with a random 4–8 second gap), but the risk is never zero.
          </li>
          <li>
            <strong>It breaks occasionally.</strong> A WhatsApp Web update can stop the library working until it is
            updated; the phone can also unlink the session by itself.
          </li>
          <li>
            <strong>Email is never affected.</strong> If the session is down at digest time, reps still get their
            email and the log says <code>session_down</code> — nothing is retried later.
          </li>
        </ul>
        {!enabled ? (
          <p className="muted-text">
            While this is off, the server never launches a browser and no WhatsApp rows are written to the reminder
            log.
          </p>
        ) : null}
      </Card>

      <Card
        title="Session"
        actions={
          <div className="panel-actions">
            <StatusChip value={view.label} tone={view.tone} />
            <button
              type="button"
              className="btn ghost small"
              onClick={() => restart.mutate()}
              disabled={!enabled || restart.isPending}
            >
              {restart.isPending ? 'Restarting…' : 'Restart'}
            </button>
            <button
              type="button"
              className="btn danger ghost small"
              onClick={() => setConfirmLogout(true)}
              disabled={logout.isPending}
            >
              Log out
            </button>
          </div>
        }
      >
        {statusQuery.isLoading && !s ? (
          <Loading />
        ) : (
          <>
            <div className="wa-status-grid">
              <div>
                <span className="wa-label">State</span>
                <span className="wa-value">{view.label}</span>
              </div>
              <div>
                <span className="wa-label">Last ready</span>
                <span className="wa-value">{s?.lastReadyAt ? `${timeAgo(s.lastReadyAt)} (${fmtDateTime(s.lastReadyAt)})` : 'never'}</span>
              </div>
              <div>
                <span className="wa-label">Linked number</span>
                <span className="wa-value">{s?.me?.number ? `+${s.me.number}` : '—'}</span>
              </div>
              <div>
                <span className="wa-label">Queue</span>
                <span className="wa-value">
                  {num(s?.queue || 0)} waiting{s?.sending ? ' · sending' : ''}
                </span>
              </div>
              {s?.nextRetryAt ? (
                <div>
                  <span className="wa-label">Next reconnect</span>
                  <span className="wa-value">
                    {fmtDateTime(s.nextRetryAt)} (attempt {s.attempts})
                  </span>
                </div>
              ) : null}
            </div>

            {s?.lastError ? <Banner tone="warn">Last error: {s.lastError}</Banner> : null}

            {state === 'qr_pending' && s?.qrDataUrl ? (
              <div className="wa-qr-block">
                <img className="wa-qr" src={s.qrDataUrl} alt="WhatsApp pairing QR code" width="280" height="280" />
                <ol className="wa-steps">
                  <li>Open WhatsApp on the phone that should send the digests.</li>
                  <li>
                    Tap <strong>Settings → Linked devices → Link a device</strong>.
                  </li>
                  <li>Point the camera at this code.</li>
                  <li>Keep that phone online — the session lives on it, not here.</li>
                </ol>
                <p className="muted-text">
                  The code refreshes by itself every few seconds; this page picks the new one up automatically.
                </p>
              </div>
            ) : null}

            {enabled && state === 'initializing' ? (
              <p className="muted-text">Starting the headless browser — the QR code usually appears within 10–30 seconds.</p>
            ) : null}
            {!enabled ? <p className="muted-text">Enable WhatsApp above to start a session.</p> : null}
          </>
        )}

        {confirmLogout ? (
          <div className="backfill-block">
            <h3>Unlink this session?</h3>
            <p className="muted-text">
              This logs the CRM out of WhatsApp and deletes the saved session in <code>data/wwebjs</code>. Pairing
              again means scanning a fresh QR code on the phone.
            </p>
            <div className="form-row">
              <button type="button" className="btn danger" onClick={() => logout.mutate()} disabled={logout.isPending}>
                {logout.isPending ? 'Unlinking…' : 'Yes, unlink'}
              </button>
              <button type="button" className="btn ghost" onClick={() => setConfirmLogout(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </Card>

      <Card title="Send a test message">
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            sendTest.mutate(testNumber.trim());
          }}
        >
          <input
            type="tel"
            placeholder={s?.testNumber || '+91 98765 43210'}
            value={testNumber}
            onChange={(e) => setTestNumber(e.target.value)}
          />
          <button type="submit" className="btn ghost" disabled={sendTest.isPending || state !== 'ready'}>
            {sendTest.isPending ? 'Sending…' : 'Send test message'}
          </button>
          {sendTest.isError ? <span className="form-error">{sendTest.error.message}</span> : null}
          {sendTest.isSuccess ? <span className="form-ok">Delivered to {sendTest.data.to}.</span> : null}
        </form>
        <p className="muted-text">
          A 10-digit number is assumed to be Indian (+91). The number is remembered for next time. Reps' own numbers
          and their WhatsApp opt-in live on <Link className="link" to="/reps">Reps</Link>; the session must be{' '}
          <strong>Ready</strong> before anything can be sent.
        </p>
      </Card>
    </>
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
