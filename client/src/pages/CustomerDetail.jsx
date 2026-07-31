import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import api from '../api.js';
import { inr, fmtDate } from '../format.js';
import { Card, Loading, ErrorBox, EmptyRow, StatusChip, Tabs } from '../components/ui.jsx';

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

  const { customer, invoices, payments, totals } = data;

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
          { key: 'assignments', label: 'Assignments' },
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
        <Card title="Rep assignments">
          <p className="muted-text">
            Effective-rep assignment (including “re-attribute all history”) lands in phase 2.
          </p>
        </Card>
      )}
    </div>
  );
}
