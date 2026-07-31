import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import api from '../api.js';
import { inr, inr0, fmtDate, num, qs, titleCase } from '../format.js';
import { Card, Loading, ErrorBox, EmptyRow, Banner } from '../components/ui.jsx';
import ChequeForm, { CHEQUE_STATUSES, STATUS_TONE, nextStatuses } from '../components/ChequeForm.jsx';

/** Row tone: late first, then "deposits within the reminder lead time". */
export function chequeRowClass(cheque, leadDays) {
  if (cheque.status !== 'pending' || cheque.days_to_deposit === null) return '';
  if (cheque.days_to_deposit < 0) return 'row-past-due';
  if (cheque.days_to_deposit <= leadDays) return 'row-due-soon';
  return '';
}

export default function Cheques() {
  const queryClient = useQueryClient();
  const [statuses, setStatuses] = useState([]);
  const [dueAfter, setDueAfter] = useState('');
  const [dueBefore, setDueBefore] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['cheques', statuses, dueAfter, dueBefore],
    queryFn: () =>
      api.get(
        `/cheques${qs({ status: statuses.join(','), due_after: dueAfter, due_before: dueBefore })}`
      ),
    placeholderData: (prev) => prev,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['cheques'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    queryClient.invalidateQueries({ queryKey: ['customer'] });
  };

  const create = useMutation({
    mutationFn: (body) => api.post('/cheques', body),
    onSuccess: () => {
      setAdding(false);
      refresh();
    },
  });
  const update = useMutation({
    mutationFn: ({ id, patch }) => api.put(`/cheques/${id}`, patch),
    onSuccess: () => {
      setEditing(null);
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id) => api.del(`/cheques/${id}`),
    onSuccess: refresh,
  });

  const rows = data?.rows || [];
  const leadDays = data?.leadDays ?? 3;
  const counts = data?.statusCounts || {};
  const dueSoon = rows.filter((r) => chequeRowClass(r, leadDays) === 'row-due-soon');
  const pastDue = rows.filter((r) => chequeRowClass(r, leadDays) === 'row-past-due');

  const toggleStatus = (s) =>
    setStatuses((list) => (list.includes(s) ? list.filter((x) => x !== s) : [...list, s]));

  return (
    <div className="page">
      <header className="page-header">
        <h1>Cheque register</h1>
        <p className="page-sub">
          Cheques held against customers, and when they hit the bank. Reps are reminded{' '}
          <strong>{leadDays} day(s)</strong> before a pending cheque’s deposit date.
        </p>
      </header>

      <div className="filter-bar">
        <div className="chip-row">
          {CHEQUE_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              className={`chip-toggle ${statuses.includes(s) ? 'on' : ''}`}
              onClick={() => toggleStatus(s)}
            >
              {titleCase(s)} <span className="chip-count">{counts[s] ?? 0}</span>
            </button>
          ))}
        </div>
        <label className="date-field">
          Deposits from
          <input type="date" value={dueAfter} onChange={(e) => setDueAfter(e.target.value)} />
        </label>
        <label className="date-field">
          to
          <input type="date" value={dueBefore} onChange={(e) => setDueBefore(e.target.value)} />
        </label>
        <button
          type="button"
          className="btn ghost small"
          onClick={() => {
            setStatuses([]);
            setDueAfter('');
            setDueBefore('');
          }}
        >
          Reset
        </button>
        <div className="spacer" />
        <button type="button" className="btn" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Close' : 'Add cheque'}
        </button>
      </div>

      <ErrorBox error={error || create.error || update.error || remove.error} />

      {pastDue.length ? (
        <Banner tone="warn">
          {num(pastDue.length)} pending cheque(s) worth {inr0(pastDue.reduce((s, r) => s + r.amount, 0))} are past their
          deposit date and still not marked deposited.
        </Banner>
      ) : null}
      {dueSoon.length ? (
        <Banner tone="info">
          {num(dueSoon.length)} cheque(s) worth {inr0(dueSoon.reduce((s, r) => s + r.amount, 0))} deposit within the
          next {leadDays} day(s).
        </Banner>
      ) : null}

      {adding ? (
        <Card title="Add a cheque">
          <ChequeForm onSubmit={(body) => create.mutate(body)} pending={create.isPending} onCancel={() => setAdding(false)} />
        </Card>
      ) : null}

      {isLoading && !data ? (
        <Loading />
      ) : (
        <Card
          title={`${num(data?.totals?.count || 0)} cheque(s) · ${inr0(data?.totals?.amount || 0)}`}
        >
          <div className="table-wrap">
            <table className="data-table cheque-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Rep</th>
                  <th>Cheque</th>
                  <th>Bank</th>
                  <th>Received</th>
                  <th>Deposits</th>
                  <th className="right">Amount</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.length ? (
                  rows.map((c) =>
                    editing === c.id ? (
                      <tr key={c.id}>
                        <td colSpan={9}>
                          <ChequeForm
                            cheque={c}
                            submitLabel="Save changes"
                            pending={update.isPending}
                            onCancel={() => setEditing(null)}
                            onSubmit={(patch) => update.mutate({ id: c.id, patch })}
                          />
                        </td>
                      </tr>
                    ) : (
                      <tr key={c.id} className={chequeRowClass(c, leadDays)}>
                        <td>
                          <Link className="link" to={`/customers/${c.customer_id}`}>
                            {c.customer_name}
                          </Link>
                          {c.note ? <div className="sub">{c.note}</div> : null}
                        </td>
                        <td>{c.rep_name || 'Unattributed'}</td>
                        <td className="mono">{c.cheque_number || '—'}</td>
                        <td>{c.bank_name || '—'}</td>
                        <td>{fmtDate(c.received_date)}</td>
                        <td>
                          {fmtDate(c.deposit_date)}
                          <div className="sub">{depositHint(c)}</div>
                        </td>
                        <td className="right">{inr(c.amount)}</td>
                        <td>
                          <span className={`chip ${STATUS_TONE[c.status] || 'muted'}`}>{titleCase(c.status)}</span>
                        </td>
                        <td className="right nowrap">
                          {nextStatuses(c.status).map((s) => (
                            <button
                              key={s}
                              type="button"
                              className="btn ghost small"
                              disabled={update.isPending}
                              onClick={() => update.mutate({ id: c.id, patch: { status: s } })}
                            >
                              {titleCase(s)}
                            </button>
                          ))}
                          <button type="button" className="btn ghost small" onClick={() => setEditing(c.id)}>
                            Edit
                          </button>
                          <button
                            type="button"
                            className="btn danger ghost small"
                            disabled={remove.isPending}
                            onClick={() => remove.mutate(c.id)}
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    )
                  )
                ) : (
                  <EmptyRow colSpan={9}>No cheques match these filters.</EmptyRow>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

export function depositHint(c) {
  if (c.days_to_deposit === null || c.days_to_deposit === undefined) return '';
  if (c.status !== 'pending') return '';
  if (c.days_to_deposit === 0) return 'today';
  if (c.days_to_deposit < 0) return `${Math.abs(c.days_to_deposit)} day(s) ago`;
  return `in ${c.days_to_deposit} day(s)`;
}
