import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import api from '../api.js';
import { inr, inr0, fmtDate, num, timeAgo } from '../format.js';
import { Card, KpiCard, Loading, ErrorBox, EmptyRow, StatusChip, ProgressBar } from '../components/ui.jsx';

export default function Dashboard() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get('/dashboard'),
    refetchInterval: 60000,
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;

  const k = data.kpis;
  const growth =
    k.lastMonthInvoiced.amount > 0
      ? Math.round(((k.mtdInvoiced.amount - k.lastMonthInvoiced.amount) / k.lastMonthInvoiced.amount) * 100)
      : null;

  return (
    <div className="page">
      <header className="page-header">
        <h1>Dashboard</h1>
        <p className="page-sub">Live figures from the last Zoho Books sync.</p>
      </header>

      {!data.sync.connected ? (
        <div className="banner warn">
          Zoho Books is not connected yet — <Link to="/settings">connect it in Settings</Link> to start syncing.
        </div>
      ) : null}

      {data.sync.lineItems.pending > 0 ? (
        <div className="banner info">
          Invoice line items: {num(data.sync.lineItems.synced)} of {num(data.sync.lineItems.total)} invoices
          backfilled · {num(data.sync.lineItems.pending)} pending.
        </div>
      ) : null}

      <div className="kpi-row">
        <KpiCard
          label="Customers"
          value={num(k.customers.total)}
          sub={`${num(k.customers.active)} active · ${num(k.customers.withOutstanding)} owe money`}
        />
        <KpiCard
          label="Invoiced this month"
          value={inr0(k.mtdInvoiced.amount)}
          sub={
            growth === null
              ? `${num(k.mtdInvoiced.count)} invoices`
              : `${num(k.mtdInvoiced.count)} invoices · ${growth >= 0 ? '+' : ''}${growth}% vs last month`
          }
        />
        <KpiCard
          label="Total outstanding"
          value={inr0(k.outstanding.amount)}
          sub={`${num(k.outstanding.count)} open invoices`}
          tone={k.outstanding.amount > 0 ? 'due' : ''}
        />
        <KpiCard
          label="Overdue"
          value={inr0(k.overdue.amount)}
          sub={`${num(k.overdue.count)} invoices past due date`}
          tone={k.overdue.count > 0 ? 'bad' : ''}
        />
        <KpiCard
          label="Payments this month"
          value={inr0(k.mtdPayments.amount)}
          sub={`${num(k.mtdPayments.count)} payments`}
        />
      </div>

      <div className="two-col">
        <Card title="Top outstanding customers">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Last invoice</th>
                  <th className="right">Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {data.topOutstanding.length ? (
                  data.topOutstanding.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <Link className="link" to={`/customers/${c.id}`}>
                          {c.contact_name}
                        </Link>
                      </td>
                      <td>{fmtDate(c.last_invoice_date)}</td>
                      <td className="right money-due">{inr(c.outstanding_receivable)}</td>
                    </tr>
                  ))
                ) : (
                  <EmptyRow colSpan={3}>Nothing outstanding.</EmptyRow>
                )}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Recent invoices">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Customer</th>
                  <th>Date</th>
                  <th className="right">Total</th>
                </tr>
              </thead>
              <tbody>
                {data.recentInvoices.length ? (
                  data.recentInvoices.map((inv) => (
                    <tr key={inv.id}>
                      <td>
                        <Link className="link" to={`/invoices/${inv.id}`}>
                          {inv.invoice_number}
                        </Link>
                      </td>
                      <td>{inv.customer_name}</td>
                      <td>{fmtDate(inv.invoice_date)}</td>
                      <td className="right">{inr(inv.total)}</td>
                    </tr>
                  ))
                ) : (
                  <EmptyRow colSpan={4}>No invoices synced yet.</EmptyRow>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <Card
        title="Sync status"
        actions={
          <Link className="btn ghost small" to="/settings">
            Open settings
          </Link>
        }
      >
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Entity</th>
                <th>Last run</th>
                <th>Status</th>
                <th className="right">Rows</th>
              </tr>
            </thead>
            <tbody>
              {data.sync.entities.map((e) => (
                <tr key={e.entity}>
                  <td>{e.entity.replace(/_/g, ' ')}</td>
                  <td>{e.lastRunAt ? timeAgo(e.lastRunAt) : 'never'}</td>
                  <td>
                    <StatusChip value={e.lastStatus || 'never run'} />
                  </td>
                  <td className="right">{num(e.rowCount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="backfill-block">
          <ProgressBar
            value={data.sync.apiCalls.used}
            max={data.sync.apiCalls.budget}
            label={`${num(data.sync.apiCalls.used)} / ${num(data.sync.apiCalls.budget)} Zoho API calls today`}
          />
        </div>
      </Card>
    </div>
  );
}
