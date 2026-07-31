import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import api from '../api.js';
import { inr, fmtDate, qs, titleCase } from '../format.js';
import { Card, Loading, ErrorBox, EmptyRow, Pagination, SortHeader } from '../components/ui.jsx';

export default function Payments() {
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [mode, setMode] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState('payment_date');
  const [dir, setDir] = useState('DESC');
  const [page, setPage] = useState(1);
  const perPage = 25;

  const query = qs({ search: term, mode, date_from: from, date_to: to, sort, dir, page, per_page: perPage });

  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ['payments', query],
    queryFn: () => api.get(`/payments${query}`),
    placeholderData: keepPreviousData,
  });

  function applySort(column, nextDir) {
    setSort(column);
    setDir(nextDir);
    setPage(1);
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Payments</h1>
        <p className="page-sub">Customer payments synced from Zoho Books.</p>
      </header>

      <Card
        title={data ? `${data.total.toLocaleString('en-IN')} payments · ${inr(data.totals.amount)}` : 'Payments'}
        actions={
          <form
            className="filter-bar"
            onSubmit={(e) => {
              e.preventDefault();
              setTerm(search.trim());
              setPage(1);
            }}
          >
            <input
              type="search"
              placeholder="Customer, payment no. or reference…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select value={mode} onChange={(e) => { setMode(e.target.value); setPage(1); }}>
              <option value="">All modes</option>
              {(data?.modes || []).map((m) => (
                <option key={m.mode} value={m.mode}>
                  {titleCase(m.mode)} ({m.n})
                </option>
              ))}
            </select>
            <label className="date-field">
              From
              <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} />
            </label>
            <label className="date-field">
              To
              <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} />
            </label>
            <button type="submit" className="btn">
              Apply
            </button>
          </form>
        }
      >
        <ErrorBox error={error} />
        {isLoading ? (
          <Loading />
        ) : (
          <div className="table-wrap">
            <table className={`data-table ${isFetching ? 'stale' : ''}`}>
              <thead>
                <tr>
                  <SortHeader label="Payment" column="number" sort={sort} dir={dir} onSort={applySort} />
                  <SortHeader label="Date" column="payment_date" sort={sort} dir={dir} onSort={applySort} />
                  <SortHeader label="Customer" column="customer" sort={sort} dir={dir} onSort={applySort} />
                  <th>Mode</th>
                  <th>Reference</th>
                  <th>Applied to</th>
                  <SortHeader label="Amount" column="amount" sort={sort} dir={dir} onSort={applySort} align="right" />
                </tr>
              </thead>
              <tbody>
                {data?.rows?.length ? (
                  data.rows.map((p) => (
                    <tr key={p.id}>
                      <td>{p.payment_number || p.id}</td>
                      <td>{fmtDate(p.payment_date)}</td>
                      <td>
                        {p.customer_id ? (
                          <Link className="link" to={`/customers/${p.customer_id}`}>
                            {p.customer_name}
                          </Link>
                        ) : (
                          p.customer_name || '—'
                        )}
                      </td>
                      <td>{titleCase(p.payment_mode) || '—'}</td>
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
                  <EmptyRow colSpan={7}>No payments match these filters.</EmptyRow>
                )}
              </tbody>
            </table>
          </div>
        )}

        <Pagination page={data?.page || 1} pages={data?.pages || 1} total={data?.total || 0} onPage={setPage} />
      </Card>
    </div>
  );
}
