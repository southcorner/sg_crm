import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import api from '../api.js';
import { inr, inr0, fmtDate, qs } from '../format.js';
import { Card, Loading, ErrorBox, EmptyRow, MonthPicker, Banner } from '../components/ui.jsx';
import { CustomerSearch } from '../components/CustomerPicker.jsx';

function thisMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export default function FocusPlan() {
  const queryClient = useQueryClient();
  const [month, setMonth] = useState(thisMonth());
  const [adding, setAdding] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['focus', month],
    queryFn: () => api.get(`/focus${qs({ month })}`),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['focus'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    queryClient.invalidateQueries({ queryKey: ['dormant'] });
  };

  const update = useMutation({
    mutationFn: ({ id, patch }) => api.put(`/focus/${id}`, patch),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id) => api.del(`/focus/${id}`),
    onSuccess: refresh,
  });

  const rows = data?.rows || [];
  const counts = data?.counts || { total: 0, open: 0, done: 0 };
  const reps = data?.reps || [];
  const existingIds = useMemo(() => rows.map((r) => r.customer_id), [rows]);

  return (
    <div className="page">
      <header className="page-header">
        <h1>Focus plan</h1>
        <p className="page-sub">
          The customers to push this month. Each row goes to its rep in the daily digest until it is marked done — one
          entry per customer per month.
        </p>
      </header>

      <div className="filter-bar">
        <MonthPicker value={month} onChange={(v) => v && setMonth(v)} />
        <span className="pill">{counts.open} open</span>
        <span className="pill">{counts.done} done</span>
        <span className="pill">{inr0(data?.outstandingTotal || 0)} outstanding on the plan</span>
        <div className="spacer" />
        <button type="button" className="btn" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Close' : 'Add customers'}
        </button>
      </div>

      <ErrorBox error={error || update.error || remove.error} />

      {adding ? (
        <AddCustomers
          month={month}
          existingIds={existingIds}
          onDone={() => {
            refresh();
            setAdding(false);
          }}
        />
      ) : null}

      {isLoading ? (
        <Loading />
      ) : (
        <Card title={`${counts.total} customer(s) on the ${month} plan`}>
          <div className="table-wrap">
            <table className="data-table focus-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Rep</th>
                  <th className="right">Outstanding</th>
                  <th>Last invoice</th>
                  <th>Note</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.length ? (
                  rows.map((r) => (
                    <tr key={r.id} className={r.status === 'open' ? '' : 'row-muted'}>
                      <td>
                        <Link className="link" to={`/customers/${r.customer_id}`}>
                          {r.customer_name}
                        </Link>
                        {r.customer_status !== 'active' ? <div className="sub">inactive in Zoho</div> : null}
                      </td>
                      <td>
                        <select
                          className="cell-input"
                          value={r.salesperson_id || ''}
                          onChange={(e) => update.mutate({ id: r.id, patch: { salesperson_id: e.target.value || null } })}
                        >
                          <option value="">Unattributed</option>
                          {reps.map((rep) => (
                            <option key={rep.id} value={rep.id}>
                              {rep.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className={`right ${r.outstanding_receivable > 0 ? 'money-due' : ''}`}>
                        {inr(r.outstanding_receivable)}
                      </td>
                      <td>{fmtDate(r.last_invoice_date)}</td>
                      <td className="note-cell">
                        <NoteInput
                          value={r.note || ''}
                          onSave={(note) => update.mutate({ id: r.id, patch: { note } })}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className={`chip-toggle ${r.status === 'done' ? 'on' : ''}`}
                          onClick={() =>
                            update.mutate({ id: r.id, patch: { status: r.status === 'done' ? 'open' : 'done' } })
                          }
                          title="Toggle open / done"
                        >
                          {r.status === 'done' ? 'Done' : 'Open'}
                        </button>
                      </td>
                      <td className="right">
                        <button
                          type="button"
                          className="btn danger ghost small"
                          onClick={() => remove.mutate(r.id)}
                          disabled={remove.isPending}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <EmptyRow colSpan={7}>
                    Nothing planned for this month yet — “Add customers”, or send some over from the Dormant page.
                  </EmptyRow>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

/** Inline note editor: saves on blur / Enter, reverts on Escape. */
function NoteInput({ value, onSave }) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const shown = focused ? draft : value;

  return (
    <input
      className="cell-input note-input"
      type="text"
      placeholder="What is the plan?"
      value={shown}
      onFocus={() => {
        setDraft(value);
        setFocused(true);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setFocused(false);
        if (draft !== value) onSave(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/**
 * Multi-select add flow: pick as many customers as you like, give each one a
 * note, then add them in one go. Duplicates (a 409) are reported per row rather
 * than failing the whole batch.
 */
function AddCustomers({ month, existingIds, onDone }) {
  const [picked, setPicked] = useState([]); // [{id, name, note}]
  const [results, setResults] = useState(null);
  const [saving, setSaving] = useState(false);

  const toggle = (c) =>
    setPicked((list) =>
      list.some((p) => p.id === c.id)
        ? list.filter((p) => p.id !== c.id)
        : [...list, { id: c.id, name: c.contact_name, note: '' }]
    );

  async function save() {
    setSaving(true);
    const out = [];
    for (const p of picked) {
      try {
        await api.post('/focus', { month, customer_id: p.id, note: p.note.trim() || null });
        out.push({ ...p, ok: true });
      } catch (err) {
        out.push({ ...p, ok: false, message: err.message });
      }
    }
    setSaving(false);
    setResults(out);
    setPicked(out.filter((r) => !r.ok).map(({ id, name, note }) => ({ id, name, note })));
    if (out.every((r) => r.ok)) onDone();
  }

  return (
    <Card title={`Add customers to ${month}`}>
      <CustomerSearch
        onPick={toggle}
        exclude={existingIds}
        selectedIds={picked.map((p) => p.id)}
        autoFocus
        emptyHint="Search by name, company or mobile. Customers already on this month’s plan are hidden."
      />

      {picked.length ? (
        <div className="table-wrap picked-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Note for this month</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {picked.map((p, i) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>
                    <input
                      className="cell-input note-input"
                      type="text"
                      placeholder="e.g. reorder due — push the new frame range"
                      value={p.note}
                      onChange={(e) =>
                        setPicked((list) => list.map((x, xi) => (xi === i ? { ...x, note: e.target.value } : x)))
                      }
                    />
                  </td>
                  <td className="right">
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() => setPicked((list) => list.filter((x) => x.id !== p.id))}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {results && results.some((r) => !r.ok) ? (
        <Banner tone="warn">
          {results
            .filter((r) => !r.ok)
            .map((r) => `${r.name}: ${r.message}`)
            .join(' · ')}
        </Banner>
      ) : null}

      <div className="form-row">
        <button type="button" className="btn" disabled={!picked.length || saving} onClick={save}>
          {saving ? 'Adding…' : `Add ${picked.length || ''} customer${picked.length === 1 ? '' : 's'}`.trim()}
        </button>
        <span className="muted-text">The rep defaults to whoever the customer is attributed to today.</span>
      </div>
    </Card>
  );
}
