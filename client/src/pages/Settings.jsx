import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
        <p className="page-sub">Zoho connection and sync control. More tabs land in later phases.</p>
      </header>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'zoho', label: 'Zoho' },
          { key: 'whatsapp', label: 'WhatsApp' },
          { key: 'reminders', label: 'Reminders' },
          { key: 'account', label: 'Account' },
        ]}
      />

      {tab === 'zoho' && <ZohoTab />}
      {tab === 'whatsapp' && (
        <Card title="WhatsApp">
          <p className="muted-text">The WhatsApp session and QR pairing land in phase 5.</p>
        </Card>
      )}
      {tab === 'reminders' && (
        <Card title="Reminders">
          <p className="muted-text">Digest schedule, SMTP and reminder rules land in phase 4.</p>
        </Card>
      )}
      {tab === 'account' && (
        <Card title="Account">
          <p className="muted-text">Password change lands with the reminder-engine phase.</p>
        </Card>
      )}
    </div>
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
