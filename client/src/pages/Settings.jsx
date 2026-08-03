import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import api from '../api.js';
import { fmtDateTime, timeAgo, num, titleCase, qs } from '../format.js';
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
        <p className="page-sub">
          Zoho connection, sync control, the daily reminder digest, the dealer stock report and the WhatsApp session.
        </p>
      </header>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'zoho', label: 'Zoho' },
          { key: 'reminders', label: 'Reminders' },
          { key: 'stock', label: 'Stock Report' },
          { key: 'whatsapp', label: 'WhatsApp' },
          { key: 'account', label: 'Security' },
        ]}
      />

      {tab === 'zoho' && <ZohoTab />}
      {tab === 'whatsapp' && <WhatsAppTab />}
      {tab === 'reminders' && <RemindersTab />}
      {tab === 'stock' && <StockReportTab />}
      {tab === 'account' && <SecurityTab />}
    </div>
  );
}

/**
 * The daily dealer stock report.
 *
 * This one goes to CUSTOMERS, and different customers should see different
 * catalogues — so the tab is built around PROFILES: each is a recipient list
 * with its own exclusions and its own masking threshold, and each gets its own
 * mail with its own tailored offline browser attached.
 *
 * Global settings above (master switch, send time, pre-send refresh), the
 * profile list in the middle, and a build-your-own download at the bottom for
 * the one-off "send me a Katana-only file" request.
 */
function StockReportTab() {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: () => api.get('/settings') });
  const profilesQuery = useQuery({ queryKey: ['stock-profiles'], queryFn: () => api.get('/stock-report/profiles') });

  const [globalDraft, setGlobalDraft] = useState(null);
  const [editing, setEditing] = useState(null); // profile id, or 'new'
  const [preview, setPreview] = useState(null);
  const [confirming, setConfirming] = useState(null); // profile id or 'all'

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['stock-profiles'] });
    queryClient.invalidateQueries({ queryKey: ['reminders-log'] });
  };

  const saveGlobal = useMutation({
    mutationFn: (body) => api.put('/settings', body),
    onSuccess: (res) => {
      setGlobalDraft(null);
      queryClient.setQueryData(['settings'], res);
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const createProfile = useMutation({
    mutationFn: (body) => api.post('/stock-report/profiles', body),
    onSuccess: () => {
      setEditing(null);
      refresh();
    },
  });
  const updateProfile = useMutation({
    mutationFn: ({ id, patch }) => api.put(`/stock-report/profiles/${id}`, patch),
    onSuccess: () => {
      setEditing(null);
      refresh();
    },
  });
  const removeProfile = useMutation({
    mutationFn: (id) => api.del(`/stock-report/profiles/${id}`),
    onSuccess: refresh,
  });
  const runPreview = useMutation({
    mutationFn: (id) => api.get(`/stock-report/profiles/${id}/preview`),
    onSuccess: (res) => setPreview(res),
  });
  const sendNow = useMutation({
    mutationFn: ({ id, force }) =>
      api.post('/stock-report/send', { ...(id ? { profile_id: id } : {}), ...(force ? { force: true } : {}) }),
    onSuccess: () => {
      setConfirming(null);
      refresh();
    },
  });

  if (settingsQuery.isLoading || profilesQuery.isLoading) return <Loading />;

  const settings = settingsQuery.data?.settings || {};
  const smtp = settingsQuery.data?.smtp || {};
  const cron = settingsQuery.data?.cron || {};
  const profiles = profilesQuery.data?.profiles || [];
  const brands = profilesQuery.data?.brands || [];
  const categories = profilesQuery.data?.categories || [];
  const lastRuns = profilesQuery.data?.lastRuns || [];
  const sync = profilesQuery.data?.sync || {};

  const gValue = (key) => (globalDraft && globalDraft[key] !== undefined ? globalDraft[key] : settings[key]);
  const gSet = (key, v) => setGlobalDraft((d) => ({ ...(d || {}), [key]: v }));

  const enabled = Boolean(gValue('stock_report_enabled'));
  const cronJob = (cron.jobs || []).find((j) => j.name === 'stock_report');
  const sendable = profiles.filter((p) => p.enabled && p.recipients.length);
  const lastFor = (id) => lastRuns.find((r) => r.profileId === id) || null;

  return (
    <>
      <ErrorBox
        error={
          settingsQuery.error ||
          profilesQuery.error ||
          saveGlobal.error ||
          createProfile.error ||
          updateProfile.error ||
          removeProfile.error ||
          runPreview.error ||
          sendNow.error
        }
      />

      {!smtp.configured ? (
        <Banner tone="warn">
          SMTP is not configured — nothing can be delivered. Set the mail server under the <strong>Reminders</strong>{' '}
          tab.
        </Banner>
      ) : null}
      {enabled && !sendable.length ? (
        <Banner tone="warn">
          The report is switched on, but no enabled profile has recipients — nothing will be sent.
        </Banner>
      ) : null}

      <Card
        title="Schedule"
        actions={<StatusChip value={enabled ? 'enabled' : 'off'} tone={enabled ? 'ok' : 'muted'} />}
      >
        <p className="muted-text">
          One email per profile per day, <strong>every day</strong>. Each carries a searchable offline HTML file of
          that profile's stock; quantities above its threshold read “Available”. Recipients are Bcc'd and never see
          each other.
          {cronJob ? ` Scheduled as ${cronJob.expr}.` : ''}
        </p>
        <form
          className="stack-form wide"
          onSubmit={(e) => {
            e.preventDefault();
            saveGlobal.mutate({
              stock_report_enabled: enabled,
              stock_report_time: String(gValue('stock_report_time') || '08:30'),
              stock_report_sync_first: Boolean(gValue('stock_report_sync_first')),
            });
          }}
        >
          <div className="settings-grid">
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => gSet('stock_report_enabled', e.target.checked)}
              />
              Send automatically
            </label>
            <label>
              Send time
              <input
                type="time"
                value={String(gValue('stock_report_time') || '08:30')}
                onChange={(e) => gSet('stock_report_time', e.target.value)}
              />
              <span className="hint">
                Every day. If the server is switched on after this time, the day's mails go out at boot instead.
              </span>
            </label>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={Boolean(gValue('stock_report_sync_first'))}
                onChange={(e) => gSet('stock_report_sync_first', e.target.checked)}
              />
              Refresh items from Zoho first
            </label>
          </div>
          <div className="form-row">
            <button type="submit" className="btn" disabled={saveGlobal.isPending || !globalDraft}>
              {saveGlobal.isPending ? 'Saving…' : 'Save'}
            </button>
            {saveGlobal.isSuccess && !globalDraft ? <span className="form-ok">Saved.</span> : null}
            <span className="muted-text">
              Stock last synced {sync.lastRunAt ? timeAgo(sync.lastRunAt) : 'never'}.
            </span>
          </div>
        </form>
      </Card>

      <Card
        title={`Recipient profiles (${profiles.length})`}
        actions={
          <div className="panel-actions">
            <button
              type="button"
              className="btn ghost small"
              onClick={() => setConfirming('all')}
              disabled={sendNow.isPending || !sendable.length}
            >
              Send all now
            </button>
            <button type="button" className="btn small" onClick={() => setEditing(editing === 'new' ? null : 'new')}>
              {editing === 'new' ? 'Cancel' : 'Add profile'}
            </button>
          </div>
        }
      >
        <p className="muted-text">
          Each profile is a recipient list with its own exclusions and threshold. A new profile never sends
          immediately — it joins the next scheduled send.
        </p>

        {editing === 'new' ? (
          <ProfileEditor
            brands={brands}
            categories={categories}
            defaultThreshold={profilesQuery.data?.defaultThreshold ?? 25}
            pending={createProfile.isPending}
            onCancel={() => setEditing(null)}
            onSubmit={(body) => createProfile.mutate(body)}
          />
        ) : null}

        {profiles.length ? (
          <div className="profile-list">
            {profiles.map((p) =>
              editing === p.id ? (
                <ProfileEditor
                  key={p.id}
                  profile={p}
                  brands={brands}
                  categories={categories}
                  defaultThreshold={profilesQuery.data?.defaultThreshold ?? 25}
                  pending={updateProfile.isPending}
                  onCancel={() => setEditing(null)}
                  onSubmit={(patch) => updateProfile.mutate({ id: p.id, patch })}
                />
              ) : (
                <ProfileRow
                  key={p.id}
                  profile={p}
                  brands={brands}
                  lastRun={lastFor(p.id)}
                  busy={sendNow.isPending || removeProfile.isPending}
                  onEdit={() => setEditing(p.id)}
                  onPreview={() => runPreview.mutate(p.id)}
                  onSend={() => setConfirming(p.id)}
                  onDelete={() => removeProfile.mutate(p.id)}
                />
              )
            )}
          </div>
        ) : editing !== 'new' ? (
          <p className="muted-text">
            No profiles yet. Add one to start sending — until then the report has nowhere to go.
          </p>
        ) : null}

        {confirming ? (
          <div className="confirm-block">
            <p className="muted-text">
              {confirming === 'all'
                ? `This emails every enabled profile with recipients (${sendable.length}) right now, using the saved settings.`
                : `This emails “${profiles.find((p) => p.id === confirming)?.name}” right now, using the saved settings.`}{' '}
              Anything already sent today is skipped unless you force it.
            </p>
            <div className="form-row">
              <button
                type="button"
                className="btn"
                disabled={sendNow.isPending}
                onClick={() => sendNow.mutate({ id: confirming === 'all' ? null : confirming, force: false })}
              >
                Send
              </button>
              <button
                type="button"
                className="btn ghost"
                disabled={sendNow.isPending}
                onClick={() => sendNow.mutate({ id: confirming === 'all' ? null : confirming, force: true })}
              >
                Force resend
              </button>
              <button type="button" className="btn ghost" onClick={() => setConfirming(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {sendNow.isSuccess ? (
          <div className={`state-msg ${sendNow.data.sent ? '' : 'error'}`}>
            {sendNow.data.sent
              ? `Sent ${sendNow.data.sent} mail(s)${sendNow.data.skipped ? `, ${sendNow.data.skipped} skipped` : ''}${
                  sendNow.data.failed ? `, ${sendNow.data.failed} failed` : ''
                }.`
              : `Nothing sent: ${sendNow.data.reason || (sendNow.data.results || []).map((r) => r.reason || r.error).join('; ')}`}
          </div>
        ) : null}
      </Card>

      <CustomFileCard brands={brands} categories={categories} defaultThreshold={profilesQuery.data?.defaultThreshold ?? 25} />

      {preview ? <StockPreview preview={preview} onClose={() => setPreview(null)} /> : null}
    </>
  );
}

const LAST_RUN_LABEL = {
  sent: 'sent',
  failed: 'FAILED',
  pending: 'in flight since',
  skipped_dedupe: 'already sent,',
  skipped: 'skipped',
};

/** One profile, collapsed: who it goes to, what it hides, when it last ran. */
function ProfileRow({ profile, brands, lastRun, busy, onEdit, onPreview, onSend, onDelete }) {
  const brandName = (id) => brands.find((b) => Number(b.id) === Number(id))?.name || `#${id}`;
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className={`profile-row ${profile.enabled ? '' : 'off'}`}>
      <div className="profile-head">
        <span className="profile-name">{profile.name}</span>
        <StatusChip value={profile.enabled ? 'on' : 'paused'} tone={profile.enabled ? 'ok' : 'muted'} />
        <span className="profile-meta">
          {profile.recipients.length} recipient(s) · hides above {profile.threshold}
        </span>
        <div className="spacer" />
        {lastRun ? (
          <span className="profile-meta" title={`${lastRun.status} · ${lastRun.created_at}`}>
            {LAST_RUN_LABEL[lastRun.status] || titleCase(lastRun.status)} {timeAgo(lastRun.created_at)}
          </span>
        ) : (
          <span className="profile-meta">never sent</span>
        )}
      </div>

      <div className="profile-body">
        <div className="chip-row">
          {profile.recipients.length ? (
            profile.recipients.map((r) => (
              <span key={r} className="chip info">
                {r}
              </span>
            ))
          ) : (
            <span className="muted-text">No recipients — this profile is never sent.</span>
          )}
        </div>
        {profile.excludedBrands.length || profile.excludedCategories.length ? (
          <div className="profile-excl">
            Excludes:{' '}
            {[...profile.excludedBrands.map(brandName), ...profile.excludedCategories].join(', ')}
          </div>
        ) : (
          <div className="profile-excl">Includes everything in stock.</div>
        )}
      </div>

      <div className="form-row">
        <button type="button" className="btn ghost small" onClick={onEdit}>
          Edit
        </button>
        <button type="button" className="btn ghost small" onClick={onPreview}>
          Preview
        </button>
        <a className="btn ghost small" href={`/api/stock-report/profiles/${profile.id}/file`} download>
          Download file
        </a>
        <button type="button" className="btn ghost small" onClick={onSend} disabled={busy || !profile.recipients.length}>
          Send now
        </button>
        <div className="spacer" />
        {confirmDelete ? (
          <>
            <span className="muted-text">Delete “{profile.name}”?</span>
            <button type="button" className="btn danger small" disabled={busy} onClick={onDelete}>
              Delete
            </button>
            <button type="button" className="btn ghost small" onClick={() => setConfirmDelete(false)}>
              Keep
            </button>
          </>
        ) : (
          <button type="button" className="btn danger ghost small" onClick={() => setConfirmDelete(true)}>
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

/** Add / edit form for a profile. */
function ProfileEditor({ profile, brands, categories, defaultThreshold, pending, onCancel, onSubmit }) {
  const [form, setForm] = useState(() => ({
    name: profile?.name || '',
    recipients: profile?.recipients || [],
    excludedBrands: (profile?.excludedBrands || []).map(Number),
    excludedCategories: profile?.excludedCategories || [],
    threshold: String(profile?.threshold ?? defaultThreshold),
    enabled: profile ? profile.enabled : true,
  }));
  const [recipientInput, setRecipientInput] = useState('');

  const set = (key, v) => setForm((f) => ({ ...f, [key]: v }));
  const toggle = (key, item) =>
    set(key, form[key].includes(item) ? form[key].filter((x) => x !== item) : [...form[key], item]);

  function addRecipient() {
    const raw = recipientInput.trim();
    if (!raw) return;
    const added = raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
    set('recipients', [...new Set([...form.recipients, ...added])]);
    setRecipientInput('');
  }

  return (
    <form
      className="profile-editor"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          name: form.name.trim(),
          recipients: form.recipients,
          excludedBrands: form.excludedBrands,
          excludedCategories: form.excludedCategories,
          threshold: Number(form.threshold) || defaultThreshold,
          enabled: form.enabled,
        });
      }}
    >
      <div className="settings-grid">
        <label>
          Profile name
          <input
            type="text"
            required
            placeholder="North dealers"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
          />
        </label>
        <label>
          Hide quantities above
          <input
            type="number"
            min="1"
            max="10000"
            step="1"
            value={form.threshold}
            onChange={(e) => set('threshold', e.target.value)}
          />
          <span className="hint">More than this shows “Available”; this number or fewer shows the exact count.</span>
        </label>
        <label className="checkbox-field">
          <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          Include in the daily send
        </label>
      </div>

      <div className="recipients-block">
        <h3>Recipients ({form.recipients.length})</h3>
        <div className="chip-row">
          {form.recipients.length ? (
            form.recipients.map((r) => (
              <span key={r} className="chip info recipient-chip">
                {r}
                <button
                  type="button"
                  className="chip-x"
                  title="Remove"
                  onClick={() => set('recipients', form.recipients.filter((x) => x !== r))}
                >
                  ×
                </button>
              </span>
            ))
          ) : (
            <span className="muted-text">No recipients yet.</span>
          )}
        </div>
        <div className="inline-form">
          <input
            type="text"
            className="recipient-input"
            placeholder="dealer@example.in"
            value={recipientInput}
            onChange={(e) => setRecipientInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addRecipient();
              }
            }}
          />
          <button type="button" className="btn ghost small" onClick={addRecipient}>
            Add
          </button>
        </div>
      </div>

      <ExclusionPicker
        brands={brands}
        categories={categories}
        excludedBrands={form.excludedBrands}
        excludedCategories={form.excludedCategories}
        onToggleBrand={(id) => toggle('excludedBrands', id)}
        onToggleCategory={(name) => toggle('excludedCategories', name)}
      />

      <div className="form-row">
        <button type="submit" className="btn" disabled={pending}>
          {pending ? 'Saving…' : profile ? 'Save profile' : 'Create profile'}
        </button>
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The two exclusion checklists, shared by the profile editor and the custom download. */
function ExclusionPicker({ brands, categories, excludedBrands, excludedCategories, onToggleBrand, onToggleCategory }) {
  return (
    <div className="exclude-grid">
      <div>
        <h3>Exclude brands</h3>
        <div className="check-list">
          {brands.map((b) => (
            <label key={b.id} className="check-row">
              <input
                type="checkbox"
                checked={excludedBrands.includes(Number(b.id))}
                onChange={() => onToggleBrand(Number(b.id))}
              />
              {b.name}
            </label>
          ))}
        </div>
      </div>
      <div>
        <h3>Exclude categories</h3>
        <div className="check-list">
          {categories.length ? (
            categories.map((c) => (
              <label key={c.name} className="check-row">
                <input
                  type="checkbox"
                  checked={excludedCategories.includes(c.name)}
                  onChange={() => onToggleCategory(c.name)}
                />
                {c.name} <span className="muted-text">({num(c.items)})</span>
              </label>
            ))
          ) : (
            <span className="muted-text">No stock loaded yet.</span>
          )}
        </div>
      </div>
    </div>
  );
}

/** Build a one-off file without touching anybody's profile. */
function CustomFileCard({ brands, categories, defaultThreshold }) {
  const [excludedBrands, setExcludedBrands] = useState([]);
  const [excludedCategories, setExcludedCategories] = useState([]);
  const [threshold, setThreshold] = useState(String(defaultThreshold));

  const href = `/api/stock-report/file${qs({
    threshold: Number(threshold) || defaultThreshold,
    brands: excludedBrands.join(','),
    categories: excludedCategories.join(','),
  })}`;

  return (
    <Card title="Custom file">
      <p className="muted-text">
        Build a one-off stock file — for a dealer who asked for “just the rackets”, say — without creating a profile.
        Nothing is emailed; the file downloads to this machine.
      </p>
      <div className="settings-grid">
        <label>
          Hide quantities above
          <input
            type="number"
            min="1"
            max="10000"
            step="1"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
          />
        </label>
      </div>
      <ExclusionPicker
        brands={brands}
        categories={categories}
        excludedBrands={excludedBrands}
        excludedCategories={excludedCategories}
        onToggleBrand={(id) =>
          setExcludedBrands((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]))
        }
        onToggleCategory={(name) =>
          setExcludedCategories((list) => (list.includes(name) ? list.filter((x) => x !== name) : [...list, name]))
        }
      />
      <div className="form-row">
        <a className="btn" href={href} download>
          Download file
        </a>
      </div>
    </Card>
  );
}

/** The composed mail for a profile: summary body, plus what the attachment holds. */
function StockPreview({ preview, onClose }) {
  return (
    <Card
      title={`Preview · ${preview.profileName || 'profile'} · ${preview.runDate}`}
      actions={
        <button type="button" className="btn ghost small" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="stat-strip">
        <span>
          Models <strong>{num(preview.counts.models)}</strong>
        </span>
        <span>
          Items <strong>{num(preview.counts.items)}</strong>
        </span>
        <span>
          Brands <strong>{num(preview.counts.brands)}</strong>
        </span>
        <span>
          Hidden above <strong>{num(preview.threshold)}</strong>
        </span>
        <span>
          Attachment <strong>{Math.round(preview.attachmentBytes / 1024)} KB</strong>
        </span>
      </div>
      <p className="muted-text">
        Subject: {preview.subject} · attaches <strong>{preview.file.filename}</strong> with{' '}
        {num(preview.file.rows)} model(s), chips for {preview.file.brands.join(', ') || 'no brands'}.
      </p>
      <iframe className="mail-preview short" title="Stock report body preview" srcDoc={preview.html} />
      <div className="form-row">
        {preview.profileId ? (
          <a className="btn ghost small" href={`/api/stock-report/profiles/${preview.profileId}/file`} download>
            Download this profile's file
          </a>
        ) : null}
      </div>
    </Card>
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

  const setWindow = useMutation({
    mutationFn: (months) => api.put('/settings', { line_item_backfill_months: months }),
    onSuccess: () => {
      setWindowInput('');
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      queryClient.invalidateQueries({ queryKey: ['sync-status'] });
    },
  });

  const [form, setForm] = useState({ client_id: '', client_secret: '', grant_code: '' });
  const [budgetInput, setBudgetInput] = useState('');
  const [windowInput, setWindowInput] = useState('');

  const status = statusQuery.data;
  const sync = syncQuery.data;
  const lineItems = sync?.lineItems || {
    total: 0,
    synced: 0,
    pending: 0,
    outsideWindow: 0,
    windowMonths: 6,
  };
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
            }${lineItems.missing ? ` · ${num(lineItems.missing)} missing in Zoho` : ''}`}
          />

          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              const months = Number(windowInput);
              if (Number.isInteger(months) && months >= 0 && months <= 120) setWindow.mutate(months);
            }}
          >
            <label className="date-field">
              Backfill window (months)
              <input
                type="number"
                min="0"
                max="120"
                step="1"
                placeholder={String(lineItems.windowMonths ?? 6)}
                value={windowInput}
                onChange={(e) => setWindowInput(e.target.value)}
              />
            </label>
            <button type="submit" className="btn ghost" disabled={setWindow.isPending}>
              {setWindow.isPending ? 'Saving…' : 'Update window'}
            </button>
            {setWindow.isError ? <span className="form-error">{setWindow.error.message}</span> : null}
          </form>

          {lineItems.outsideWindow > 0 ? (
            <p className="muted-text">
              Skipping {num(lineItems.outsideWindow)} older invoices (window:{' '}
              {lineItems.windowMonths} months
              {lineItems.cutoff ? `, on or after ${lineItems.cutoff}` : ''}). Raise the window to pull
              them in — nothing is discarded.
            </p>
          ) : null}

          <p className="muted-text">
            Every invoice needs its own API call for line items, so the first backfill can take a few days
            within the daily call budget. It resumes automatically on each sync, newest invoices first.
            Set the window to <strong>0</strong> to backfill every invoice regardless of age.
          </p>
        </div>
      </Card>
    </>
  );
}
