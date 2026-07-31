import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../api.js';
import { num } from '../format.js';
import { Card, Loading, ErrorBox, EmptyRow, Banner } from '../components/ui.jsx';

export default function Reps() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['reps'], queryFn: () => api.get('/reps') });

  const save = useMutation({
    mutationFn: ({ id, ...body }) => api.put(`/reps/${encodeURIComponent(id)}`, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['reps'] }),
  });

  // The visibility scope is two settings edited as one thing, so it is saved in
  // one go rather than one checkbox at a time — flipping five reps should be one
  // write, not five re-filtered reloads of the entire CRM. Unattributed data is
  // the extra pseudo-row in the same list.
  const rowsData = data?.rows;
  const serverVisible = useMemo(
    () => (rowsData || []).filter((r) => r.visible).map((r) => r.id),
    [rowsData]
  );
  const serverUnattributed = data?.repScope?.showUnattributed ?? true;
  const [draft, setDraft] = useState(null);
  useEffect(() => {
    setDraft(null);
  }, [serverVisible, serverUnattributed]);

  const saveScope = useMutation({
    mutationFn: (body) => api.put('/settings', body),
    onSuccess: () => {
      setDraft(null);
      // the scope changes what every other screen shows
      queryClient.invalidateQueries();
    },
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;

  const rows = data?.rows || [];
  const scope = data?.repScope || {
    active: false,
    visible: rows.length,
    total: rows.length,
    hidden: 0,
    showUnattributed: true,
  };
  const visibleIds = draft ? draft.ids : serverVisible;
  const unattributedOn = draft ? draft.unattributed : serverUnattributed;
  const visibleSet = new Set(visibleIds);
  const scopeDirty = draft !== null;
  const allVisible = visibleIds.length === rows.length;

  function toggleVisible(id, on) {
    const next = new Set(visibleIds);
    if (on) next.add(id);
    else next.delete(id);
    setDraft({
      ids: rows.filter((r) => next.has(r.id)).map((r) => r.id),
      unattributed: unattributedOn,
    });
  }

  function toggleUnattributed(on) {
    setDraft({ ids: visibleIds, unattributed: on });
  }

  function saveVisibility() {
    saveScope.mutate({
      // all reps ticked === "no rep filter at all", which is null, not a list of
      // everyone: a rep synced from Zoho tomorrow should then be visible too
      visible_rep_ids: allVisible ? null : visibleIds,
      show_unattributed: unattributedOn,
    });
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Reps</h1>
        <p className="page-sub">
          Salespersons come from Zoho Books; their name and Zoho email are overwritten by every sync. The contact and
          notification settings below are CRM-owned and are never touched by a sync — they drive the daily reminder
          digests from phase 4.
        </p>
      </header>

      <ErrorBox error={save.error || saveScope.error} />

      {scope.active ? (
        <Banner tone="warn">
          {scope.hidden ? (
            <>
              The CRM is currently showing <strong>{num(scope.visible)} of {num(scope.total)} reps</strong>.{' '}
              {num(scope.hidden)} rep(s) and everything belonging to their customers are hidden from every other page.
            </>
          ) : null}
          {scope.hidden && !scope.showUnattributed ? ' ' : null}
          {!scope.showUnattributed ? (
            <>
              Records with <strong>no salesperson at all</strong> are hidden too.
            </>
          ) : null}
        </Banner>
      ) : null}

      <Card
        title={`Salespersons · ${num(rows.length)}`}
        actions={
          <div className="panel-actions">
            {scopeDirty ? <span className="form-error">Unsaved visibility changes</span> : null}
            {saveScope.isSuccess && !scopeDirty ? <span className="form-ok">Saved.</span> : null}
            <button
              type="button"
              className="btn"
              onClick={saveVisibility}
              disabled={!scopeDirty || saveScope.isPending}
            >
              {saveScope.isPending ? 'Saving…' : 'Save visibility'}
            </button>
          </div>
        }
      >
        <p className="muted-text">
          <strong>Visible in CRM</strong> controls which reps this CRM operates on. Unchecked reps’ customers, sales,
          invoices, payments, cheques, focus items and reminder digests are hidden across every page — the data is
          never deleted, just filtered out. The pinned <em>Unattributed</em> row is the same switch for records that
          carry no salesperson at all. Tick everything to turn the filter off completely.
        </p>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Visible in CRM</th>
                <th>Name</th>
                <th>Zoho email</th>
                <th>CRM email</th>
                <th>WhatsApp</th>
                <th>Email digest</th>
                <th>WhatsApp digest</th>
                <th>Active</th>
                <th className="right">Assignments</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {/* not a salesperson — the bucket every record with no rep falls
                  into, switched the same way and saved by the same button */}
              <tr className={`unattributed-row ${unattributedOn ? '' : 'row-muted'}`}>
                <td>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={unattributedOn}
                      onChange={(e) => toggleUnattributed(e.target.checked)}
                    />
                    {unattributedOn ? 'Shown' : 'Hidden'}
                  </label>
                </td>
                <td colSpan={9}>
                  <strong>Unattributed</strong> <span className="sub">(no salesperson)</span>
                  <div className="sub">
                    Customers and invoices Zoho has no salesperson for. They belong to no rep, so they never appear in
                    anyone’s reminder digest either way.
                  </div>
                </td>
              </tr>
              {rows.length ? (
                rows.map((rep) => (
                  <RepRow
                    key={rep.id}
                    rep={rep}
                    visible={visibleSet.has(rep.id)}
                    onToggleVisible={(on) => toggleVisible(rep.id, on)}
                    onSave={(patch) => save.mutate({ id: rep.id, ...patch })}
                    busy={save.isPending}
                  />
                ))
              ) : (
                <EmptyRow colSpan={10}>No salespersons synced yet — run a Zoho sync first.</EmptyRow>
              )}
            </tbody>
          </table>
        </div>
        <p className="muted-text">
          WhatsApp numbers are stored as digits with the country code, e.g. <code>919876543210</code>. Anything you
          type is normalised on save. A rep with no CRM email falls back to their Zoho email.
        </p>
      </Card>
    </div>
  );
}

function RepRow({ rep, visible, onToggleVisible, onSave, busy }) {
  const [form, setForm] = useState({ crm_email: rep.crm_email || '', whatsapp_number: rep.whatsapp_number || '' });
  const dirty = form.crm_email !== (rep.crm_email || '') || form.whatsapp_number !== (rep.whatsapp_number || '');

  return (
    <tr className={rep.is_active && visible ? '' : 'row-muted'}>
      <td>
        <label className="check">
          <input type="checkbox" checked={visible} onChange={(e) => onToggleVisible(e.target.checked)} />
          {visible ? 'Shown' : 'Hidden'}
        </label>
      </td>
      <td>{rep.name}</td>
      <td className="sub">{rep.email || '—'}</td>
      <td>
        <input
          className="cell-input"
          type="email"
          placeholder={rep.email || 'rep@example.in'}
          value={form.crm_email}
          onChange={(e) => setForm({ ...form, crm_email: e.target.value })}
        />
      </td>
      <td>
        <input
          className="cell-input"
          type="tel"
          placeholder="919876543210"
          value={form.whatsapp_number}
          onChange={(e) => setForm({ ...form, whatsapp_number: e.target.value })}
        />
      </td>
      <td>
        <label className="check">
          <input
            type="checkbox"
            checked={rep.notify_email}
            onChange={(e) => onSave({ notify_email: e.target.checked })}
          />
        </label>
      </td>
      <td>
        <label className="check">
          <input
            type="checkbox"
            checked={rep.notify_whatsapp}
            onChange={(e) => onSave({ notify_whatsapp: e.target.checked })}
          />
        </label>
      </td>
      <td>
        <label className="check">
          <input type="checkbox" checked={rep.is_active} onChange={(e) => onSave({ is_active: e.target.checked })} />
          {rep.is_active ? 'Active' : 'Off'}
        </label>
      </td>
      <td className="right">{num(rep.assignment_count)}</td>
      <td className="right">
        <button
          type="button"
          className="btn small"
          disabled={!dirty || busy}
          onClick={() => onSave({ crm_email: form.crm_email.trim(), whatsapp_number: form.whatsapp_number.trim() })}
        >
          Save
        </button>
      </td>
    </tr>
  );
}
