import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../api.js';
import { num } from '../format.js';
import { Card, Loading, ErrorBox, EmptyRow } from '../components/ui.jsx';

export default function Reps() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['reps'], queryFn: () => api.get('/reps') });

  const save = useMutation({
    mutationFn: ({ id, ...body }) => api.put(`/reps/${encodeURIComponent(id)}`, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['reps'] }),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;

  const rows = data?.rows || [];

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

      <ErrorBox error={save.error} />

      <Card title={`Salespersons · ${num(rows.length)}`}>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
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
              {rows.length ? (
                rows.map((rep) => (
                  <RepRow key={rep.id} rep={rep} onSave={(patch) => save.mutate({ id: rep.id, ...patch })} busy={save.isPending} />
                ))
              ) : (
                <EmptyRow colSpan={9}>No salespersons synced yet — run a Zoho sync first.</EmptyRow>
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

function RepRow({ rep, onSave, busy }) {
  const [form, setForm] = useState({ crm_email: rep.crm_email || '', whatsapp_number: rep.whatsapp_number || '' });
  const dirty = form.crm_email !== (rep.crm_email || '') || form.whatsapp_number !== (rep.whatsapp_number || '');

  return (
    <tr className={rep.is_active ? '' : 'row-muted'}>
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
