import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import api from '../api.js';
import { inr, fmtDate, fmtDateTime } from '../format.js';
import { Card, Loading, ErrorBox, EmptyRow, StatusChip, Tabs, Banner } from '../components/ui.jsx';

function addressLines(addr) {
  if (!addr) return [];
  return [addr.attention, addr.address, addr.street2, [addr.city, addr.state, addr.zip].filter(Boolean).join(' '), addr.country]
    .filter(Boolean)
    .map(String);
}

export default function CustomerDetail() {
  const { id } = useParams();
  const [tab, setTab] = useState('invoices');

  const { data, isLoading, error } = useQuery({
    queryKey: ['customer', id],
    queryFn: () => api.get(`/customers/${encodeURIComponent(id)}`),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;

  const { customer, invoices, payments, totals, effectiveRep, assignments = [] } = data;

  return (
    <div className="page">
      <header className="page-header">
        <Link className="back-link" to="/customers">
          ← Customers
        </Link>
        <h1>{customer.contact_name}</h1>
        <p className="page-sub">
          {customer.company_name || '—'}
          {customer.place_of_contact ? ` · ${customer.place_of_contact}` : ''}
        </p>
      </header>

      <div className="kpi-row">
        <div className="kpi">
          <div className="kpi-label">Outstanding</div>
          <div className={`kpi-value ${customer.outstanding_receivable > 0 ? 'money-due' : ''}`}>
            {inr(customer.outstanding_receivable)}
          </div>
          <div className="kpi-sub">{totals.overdue_count || 0} overdue invoice(s)</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Invoiced (all time)</div>
          <div className="kpi-value">{inr(totals.invoiced_total)}</div>
          <div className="kpi-sub">{customer.invoice_count || 0} invoices</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Payments received</div>
          <div className="kpi-value">{inr(totals.payments_total)}</div>
          <div className="kpi-sub">{payments.length} payments</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Activity</div>
          <div className="kpi-value small">{fmtDate(customer.last_invoice_date)}</div>
          <div className="kpi-sub">first: {fmtDate(customer.first_invoice_date)}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Effective rep</div>
          <div className="kpi-value small">{effectiveRep?.salesperson_name || 'Unattributed'}</div>
          <div className="kpi-sub">
            {effectiveRep?.source === 'assignment'
              ? effectiveRep.all_history
                ? 'assigned (all history)'
                : `assigned since ${fmtDate(effectiveRep.since)}`
              : effectiveRep?.source === 'invoice'
                ? 'from the latest invoice'
                : 'no rep on record'}
          </div>
        </div>
      </div>

      <Card title="Overview">
        <div className="detail-grid">
          <dl className="kv">
            <dt>Mobile</dt>
            <dd>{customer.mobile || '—'}</dd>
            <dt>Phone</dt>
            <dd>{customer.phone || '—'}</dd>
            <dt>Email</dt>
            <dd>{customer.email || '—'}</dd>
            <dt>GSTIN</dt>
            <dd>{customer.gst_no || '—'}</dd>
            <dt>Payment terms</dt>
            <dd>{customer.payment_terms_label || (customer.payment_terms ? `Net ${customer.payment_terms}` : '—')}</dd>
            <dt>Status</dt>
            <dd>
              <StatusChip value={customer.status} tone={customer.status === 'active' ? 'ok' : 'muted'} />
            </dd>
          </dl>
          <div className="addr-block">
            <h3>Billing address</h3>
            {addressLines(customer.billing_address).length ? (
              addressLines(customer.billing_address).map((line, i) => <div key={i}>{line}</div>)
            ) : (
              <div className="sub">Not on file</div>
            )}
            <h3>Shipping address</h3>
            {addressLines(customer.shipping_address).length ? (
              addressLines(customer.shipping_address).map((line, i) => <div key={i}>{line}</div>)
            ) : (
              <div className="sub">Not on file</div>
            )}
          </div>
        </div>
      </Card>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'invoices', label: 'Invoices', count: invoices.length },
          { key: 'payments', label: 'Payments', count: payments.length },
          { key: 'cheques', label: 'Cheques' },
          { key: 'assignments', label: 'Assignments', count: assignments.length },
        ]}
      />

      {tab === 'invoices' && (
        <Card>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Date</th>
                  <th>Due</th>
                  <th>Salesperson</th>
                  <th>Status</th>
                  <th className="right">Total</th>
                  <th className="right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {invoices.length ? (
                  invoices.map((inv) => (
                    <tr key={inv.id}>
                      <td>
                        <Link className="link" to={`/invoices/${inv.id}`}>
                          {inv.invoice_number}
                        </Link>
                      </td>
                      <td>{fmtDate(inv.invoice_date)}</td>
                      <td>{fmtDate(inv.due_date)}</td>
                      <td>{inv.salesperson_name || '—'}</td>
                      <td>
                        <StatusChip value={inv.status} />
                      </td>
                      <td className="right">{inr(inv.total)}</td>
                      <td className={`right ${inv.balance > 0 ? 'money-due' : ''}`}>{inr(inv.balance)}</td>
                    </tr>
                  ))
                ) : (
                  <EmptyRow colSpan={7}>No invoices synced for this customer.</EmptyRow>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {tab === 'payments' && (
        <Card>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Payment</th>
                  <th>Date</th>
                  <th>Mode</th>
                  <th>Reference</th>
                  <th>Applied to</th>
                  <th className="right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {payments.length ? (
                  payments.map((p) => (
                    <tr key={p.id}>
                      <td>{p.payment_number || p.id}</td>
                      <td>{fmtDate(p.payment_date)}</td>
                      <td>{p.payment_mode || '—'}</td>
                      <td>{p.reference_number || '—'}</td>
                      <td>
                        {p.applied_invoices?.length
                          ? p.applied_invoices.map((a) => a.invoice_number || a.invoice_id).join(', ')
                          : 'On account'}
                      </td>
                      <td className="right">{inr(p.amount)}</td>
                    </tr>
                  ))
                ) : (
                  <EmptyRow colSpan={6}>No payments synced for this customer.</EmptyRow>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {tab === 'cheques' && (
        <Card title="Cheques">
          <p className="muted-text">The cheque register lands in phase 3.</p>
        </Card>
      )}

      {tab === 'assignments' && (
        <AssignmentsTab customerId={id} effectiveRep={effectiveRep} assignments={assignments} />
      )}
    </div>
  );
}

/**
 * Current effective rep + the full reassignment history, with a dialog that
 * spells out exactly what each mode does before the admin commits to it.
 */
function AssignmentsTab({ customerId, effectiveRep, assignments }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ salesperson_id: '', mode: 'from_today', note: '' });

  const repsQuery = useQuery({ queryKey: ['reps'], queryFn: () => api.get('/reps') });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['customer', customerId] });
    queryClient.invalidateQueries({ queryKey: ['customers'] });
    queryClient.invalidateQueries({ queryKey: ['performance'] });
  };

  const assign = useMutation({
    mutationFn: (body) => api.post(`/customers/${encodeURIComponent(customerId)}/assign`, body),
    onSuccess: () => {
      setOpen(false);
      setForm({ salesperson_id: '', mode: 'from_today', note: '' });
      refresh();
    },
  });

  const undo = useMutation({
    mutationFn: (assignmentId) =>
      api.del(`/customers/${encodeURIComponent(customerId)}/assignments/${assignmentId}`),
    onSuccess: refresh,
  });

  const reps = (repsQuery.data?.rows || []).filter((r) => r.is_active);

  return (
    <Card
      title="Rep assignments"
      actions={
        <button type="button" className="btn" onClick={() => setOpen((v) => !v)}>
          {open ? 'Cancel' : 'Reassign'}
        </button>
      }
    >
      <ErrorBox error={assign.error || undo.error} />

      <div className="status-row">
        <span className="chip info">{effectiveRep?.salesperson_name || 'Unattributed'}</span>
        <span className="muted-text">
          {effectiveRep?.source === 'assignment'
            ? effectiveRep.all_history
              ? 'assigned for all history'
              : `assigned from ${fmtDate(effectiveRep.since)}`
            : effectiveRep?.source === 'invoice'
              ? 'inherited from the salesperson on the latest invoice — no explicit assignment'
              : 'no assignment and no salesperson on any invoice'}
        </span>
      </div>

      {open ? (
        <form
          className="stack-form assign-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!form.salesperson_id) return;
            assign.mutate({
              salesperson_id: form.salesperson_id,
              mode: form.mode,
              note: form.note.trim() || null,
            });
          }}
        >
          <label>
            Assign to
            <select
              value={form.salesperson_id}
              onChange={(e) => setForm({ ...form, salesperson_id: e.target.value })}
              required
            >
              <option value="">Choose a rep…</option>
              {reps.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>

          <fieldset className="radio-set">
            <legend>What should move?</legend>
            <label className="radio">
              <input
                type="radio"
                name="mode"
                checked={form.mode === 'from_today'}
                onChange={() => setForm({ ...form, mode: 'from_today' })}
              />
              <span>
                <strong>From today</strong>
                <em>
                  Invoices dated today or later are attributed to the new rep. Everything already invoiced stays
                  with whoever earned it, so past months’ performance figures do not move.
                </em>
              </span>
            </label>
            <label className="radio">
              <input
                type="radio"
                name="mode"
                checked={form.mode === 'all_history'}
                onChange={() => setForm({ ...form, mode: 'all_history' })}
              />
              <span>
                <strong>Re-attribute all history</strong>
                <em>
                  <b>Every</b> invoice this customer has ever had — past, present and future — is credited to the new
                  rep. Historic month-on-month charts, rep summaries and target achievement will all change. The Zoho
                  invoices themselves are never modified, and this is reversible: undo the entry in the history below
                  and the old attribution comes straight back.
                </em>
              </span>
            </label>
          </fieldset>

          <label>
            Note (optional)
            <input
              type="text"
              placeholder="Why is this changing?"
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
            />
          </label>

          <div className="form-row">
            <button type="submit" className="btn" disabled={assign.isPending || !form.salesperson_id}>
              {assign.isPending ? 'Saving…' : 'Reassign'}
            </button>
          </div>
        </form>
      ) : null}

      {assignments.length ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Rep</th>
                <th>Covers</th>
                <th>Mode</th>
                <th>State</th>
                <th>Note</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {assignments.map((a) => (
                <tr key={a.id} className={a.is_active ? '' : 'row-muted'}>
                  <td>{a.salesperson_name || a.salesperson_id}</td>
                  <td>
                    {a.all_history ? 'all history' : `from ${fmtDate(a.effective_from)}`}
                    {a.effective_to ? ` until ${fmtDate(a.effective_to)}` : ''}
                  </td>
                  <td>{a.mode === 'all_history' ? 'All history' : 'From today'}</td>
                  <td>
                    {a.is_active ? (
                      a.effective_to ? (
                        <span className="chip muted">Closed</span>
                      ) : (
                        <span className="chip ok">Active</span>
                      )
                    ) : (
                      <span className="chip muted">Superseded</span>
                    )}
                  </td>
                  <td className="sub">{a.note || '—'}</td>
                  <td className="sub">{fmtDateTime(a.created_at)}</td>
                  <td className="right">
                    <button
                      type="button"
                      className="btn danger ghost small"
                      onClick={() => undo.mutate(a.id)}
                      disabled={undo.isPending}
                      title="Delete this entry and restore what it replaced"
                    >
                      Undo
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Banner tone="info">
          No explicit assignment — this customer’s invoices are attributed to whoever Zoho recorded as the
          salesperson on each one.
        </Banner>
      )}
    </Card>
  );
}
