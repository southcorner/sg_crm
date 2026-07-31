import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import api from '../api.js';
import { inr, fmtDate, num } from '../format.js';
import { Card, Loading, ErrorBox, EmptyRow, StatusChip } from '../components/ui.jsx';

export default function InvoiceDetail() {
  const { id } = useParams();

  const { data, isLoading, error } = useQuery({
    queryKey: ['invoice', id],
    queryFn: () => api.get(`/invoices/${encodeURIComponent(id)}`),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;

  const { invoice, lineItems, payments } = data;
  const lineTotal = lineItems.reduce((sum, li) => sum + Number(li.item_total || 0), 0);

  return (
    <div className="page">
      <header className="page-header">
        <Link className="back-link" to="/invoices">
          ← Invoices
        </Link>
        <h1>
          {invoice.invoice_number} <StatusChip value={invoice.status} />
        </h1>
        <p className="page-sub">
          {invoice.customer_id ? (
            <Link className="link" to={`/customers/${invoice.customer_id}`}>
              {invoice.customer_name}
            </Link>
          ) : (
            invoice.customer_name
          )}
        </p>
      </header>

      <Card title="Invoice">
        <div className="detail-grid">
          <dl className="kv">
            <dt>Invoice date</dt>
            <dd>{fmtDate(invoice.invoice_date)}</dd>
            <dt>Due date</dt>
            <dd>{fmtDate(invoice.due_date)}</dd>
            <dt>Salesperson</dt>
            <dd>{invoice.salesperson_name || '—'}</dd>
            <dt>Reference</dt>
            <dd>{invoice.reference_number || '—'}</dd>
          </dl>
          <dl className="kv">
            <dt>Sub total</dt>
            <dd>{inr(invoice.sub_total)}</dd>
            <dt>Total</dt>
            <dd>
              <strong>{inr(invoice.total)}</strong>
            </dd>
            <dt>Balance</dt>
            <dd className={invoice.balance > 0 ? 'money-due' : ''}>
              <strong>{inr(invoice.balance)}</strong>
            </dd>
            <dt>Line items</dt>
            <dd>{invoice.line_items_synced ? `${lineItems.length} synced` : 'pending backfill'}</dd>
          </dl>
        </div>
      </Card>

      <Card title="Line items">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Item</th>
                <th>SKU</th>
                <th className="right">Qty</th>
                <th className="right">Rate</th>
                <th className="right">Discount</th>
                <th className="right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {lineItems.length ? (
                lineItems.map((li, idx) => (
                  <tr key={li.id}>
                    <td>{idx + 1}</td>
                    <td>
                      {li.name}
                      {li.description && li.description !== li.name ? (
                        <div className="sub">{li.description}</div>
                      ) : null}
                    </td>
                    <td>{li.sku || '—'}</td>
                    <td className="right">
                      {num(li.quantity)} {li.unit || ''}
                    </td>
                    <td className="right">{inr(li.rate)}</td>
                    <td className="right">{li.discount_amount ? inr(li.discount_amount) : '—'}</td>
                    <td className="right">{inr(li.item_total)}</td>
                  </tr>
                ))
              ) : (
                <EmptyRow colSpan={7}>
                  {invoice.line_items_synced
                    ? 'This invoice has no line items.'
                    : 'Line items have not been backfilled yet — run a sync from Settings.'}
                </EmptyRow>
              )}
            </tbody>
            {lineItems.length ? (
              <tfoot>
                <tr>
                  <td colSpan={6} className="right">
                    Line items total
                  </td>
                  <td className="right">
                    <strong>{inr(lineTotal)}</strong>
                  </td>
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      </Card>

      <Card title="Payments applied">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Payment</th>
                <th>Date</th>
                <th>Mode</th>
                <th>Reference</th>
                <th className="right">Applied</th>
                <th className="right">Payment total</th>
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
                    <td className="right">{p.amount_applied !== null ? inr(p.amount_applied) : '—'}</td>
                    <td className="right">{inr(p.amount)}</td>
                  </tr>
                ))
              ) : (
                <EmptyRow colSpan={6}>No payments recorded against this invoice.</EmptyRow>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
