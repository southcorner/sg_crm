import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import api from '../api.js';
import { inr, inr0, fmtDate, num, qs } from '../format.js';
import { Card, Loading, ErrorBox, EmptyRow } from '../components/ui.jsx';

function thisMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export default function Dormant() {
  const queryClient = useQueryClient();
  const [months, setMonths] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [added, setAdded] = useState({}); // customer id → 'ok' | error message

  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: () => api.get('/settings') });

  // the threshold input starts at the saved default and can then be nudged per view
  useEffect(() => {
    const saved = settingsQuery.data?.settings?.dormant_months;
    if (saved !== undefined && months === '') setMonths(String(saved));
  }, [settingsQuery.data, months]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['dormant', months, includeInactive],
    queryFn: () => api.get(`/dormant${qs({ months, include_inactive: includeInactive ? 1 : '' })}`),
    placeholderData: (prev) => prev,
  });

  const saveDefault = useMutation({
    mutationFn: (value) => api.put('/settings', { dormant_months: Number(value) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  const addToFocus = useMutation({
    mutationFn: (customerId) => api.post('/focus', { month: thisMonth(), customer_id: customerId }),
    onSuccess: (_res, customerId) => {
      setAdded((a) => ({ ...a, [customerId]: 'ok' }));
      queryClient.invalidateQueries({ queryKey: ['focus'] });
      queryClient.invalidateQueries({ queryKey: ['dormant'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (err, customerId) => {
      // already on the plan is not really a failure — say so and move on
      setAdded((a) => ({ ...a, [customerId]: err.status === 409 ? 'ok' : err.message }));
    },
  });

  const rows = data?.rows || [];
  const savedDefault = settingsQuery.data?.settings?.dormant_months;
  const dirtyDefault = months !== '' && Number(months) !== Number(savedDefault);

  return (
    <div className="page">
      <header className="page-header">
        <h1>Dormant customers</h1>
        <p className="page-sub">
          Customers who have bought before but not since{' '}
          <strong>{data ? fmtDate(data.threshold) : '—'}</strong> — {data?.months ?? '—'} month(s) back. Voided invoices
          do not count as activity.
        </p>
      </header>

      <div className="filter-bar">
        <label className="month-picker">
          <span>Dormant after</span>
          <input
            type="number"
            min="1"
            max="120"
            step="1"
            value={months}
            onChange={(e) => setMonths(e.target.value)}
            style={{ width: 70 }}
          />
        </label>
        <span className="muted-text">months without an invoice</span>
        <button
          type="button"
          className="btn ghost small"
          disabled={!dirtyDefault || saveDefault.isPending}
          onClick={() => saveDefault.mutate(months)}
          title="Store this as the default used by the dashboard and the daily digest"
        >
          {saveDefault.isPending ? 'Saving…' : dirtyDefault ? 'Save as default' : `Default: ${savedDefault ?? '—'}`}
        </button>
        <label className="check">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
          Include inactive customers
        </label>
        <div className="spacer" />
        <span className="pill">{num(data?.total || 0)} dormant</span>
        <span className="pill">{inr0(data?.outstandingTotal || 0)} outstanding</span>
      </div>

      <ErrorBox error={error || saveDefault.error} />

      {isLoading && !data ? (
        <Loading />
      ) : (
        <Card title={`Dormant since before ${fmtDate(data?.threshold)}`}>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Effective rep</th>
                  <th>Last invoice</th>
                  <th className="right">Months dormant</th>
                  <th className="right">Outstanding</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.length ? (
                  rows.map((r) => {
                    const state = added[r.id];
                    const onPlan = r.in_focus || state === 'ok';
                    return (
                      <tr key={r.id}>
                        <td>
                          <Link className="link" to={`/customers/${r.id}`}>
                            {r.contact_name}
                          </Link>
                          <div className="sub">
                            {r.place_of_contact || '—'}
                            {r.status !== 'active' ? ' · inactive in Zoho' : ''}
                          </div>
                        </td>
                        <td>{r.effective_rep_name || 'Unattributed'}</td>
                        <td>{fmtDate(r.last_invoice_date)}</td>
                        <td className="right">{r.months_dormant}</td>
                        <td className={`right ${r.outstanding_receivable > 0 ? 'money-due' : ''}`}>
                          {inr(r.outstanding_receivable)}
                        </td>
                        <td className="right">
                          {onPlan ? (
                            <span className="chip ok">On this month’s plan</span>
                          ) : (
                            <button
                              type="button"
                              className="btn ghost small"
                              disabled={addToFocus.isPending}
                              onClick={() => addToFocus.mutate(r.id)}
                            >
                              Add to focus plan
                            </button>
                          )}
                          {state && state !== 'ok' ? <div className="sub error-text">{state}</div> : null}
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <EmptyRow colSpan={6}>
                    Nobody has gone quiet for that long — try a shorter window.
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
