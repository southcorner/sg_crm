import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import api from '../api.js';
import { inr, fmtDate, qs, titleCase } from '../format.js';
import { Card, Loading, ErrorBox, EmptyRow, Pagination, SortHeader, StatusChip } from '../components/ui.jsx';

export default function Invoices() {
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [statuses, setStatuses] = useState([]);
  const [salesperson, setSalesperson] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [sort, setSort] = useState('invoice_date');
  const [dir, setDir] = useState('DESC');
  const [page, setPage] = useState(1);
  const perPage = 25;

  const { data: meta } = useQuery({
    queryKey: ['invoice-filters'],
    queryFn: () => api.get('/invoices/meta/filters'),
  });

  const query = qs({
    search: term,
    status: statuses.join(','),
    salesperson_id: salesperson,
    date_from: from,
    date_to: to,
    overdue: overdueOnly ? '1' : '',
    sort,
    dir,
    page,
    per_page: perPage,
  });

  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ['invoices', query],
    queryFn: () => api.get(`/invoices${query}`),
    placeholderData: keepPreviousData,
  });

  function toggleStatus(status) {
    setStatuses((prev) => (prev.includes(status) ? prev.filter((s) => s !== status) : [...prev, status]));
    setPage(1);
  }

  function applySort(column, nextDir) {
    setSort(column);
    setDir(nextDir);
    setPage(1);
  }

  function resetFilters() {
    setSearch('');
    setTerm('');
    setStatuses([]);
    setSalesperson('');
    setFrom('');
    setTo('');
    setOverdueOnly(false);
    setPage(1);
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Invoices</h1>
        <p className="page-sub">Synced from Zoho Books. Line items arrive via the detail backfill pass.</p>
      </header>

      <Card title="Filters">
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
            placeholder="Invoice no., customer or reference…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            value={salesperson}
            onChange={(e) => {
              setSalesperson(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All salespersons</option>
            {(meta?.salespersons || []).map((sp) => (
              <option key={sp.id} value={sp.id}>
                {sp.name}
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
          <label className="check">
            <input
              type="checkbox"
              checked={overdueOnly}
              onChange={(e) => {
                setOverdueOnly(e.target.checked);
                setPage(1);
              }}
            />
            Overdue only
          </label>
          <button type="submit" className="btn">
            Apply
          </button>
          <button type="button" className="btn ghost" onClick={resetFilters}>
            Reset
          </button>
        </form>

        <div className="chip-row">
          {(meta?.statuses || []).map((s) => (
            <button
              key={s.status}
              type="button"
              className={`chip-toggle ${statuses.includes(s.status) ? 'on' : ''}`}
              onClick={() => toggleStatus(s.status)}
            >
              {titleCase(s.status)} <span className="chip-count">{s.n}</span>
            </button>
          ))}
        </div>
      </Card>

      <Card
        title={data ? `${data.total.toLocaleString('en-IN')} invoices` : 'Invoices'}
        actions={
          data ? (
            <div className="totals-inline">
              <span>
                Total <strong>{inr(data.totals.amount)}</strong>
              </span>
              <span>
                Balance <strong className={data.totals.balance > 0 ? 'money-due' : ''}>{inr(data.totals.balance)}</strong>
              </span>
            </div>
          ) : null
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
                  <SortHeader label="Invoice" column="number" sort={sort} dir={dir} onSort={applySort} />
                  <SortHeader label="Date" column="invoice_date" sort={sort} dir={dir} onSort={applySort} />
                  <SortHeader label="Due" column="due_date" sort={sort} dir={dir} onSort={applySort} />
                  <SortHeader label="Customer" column="customer" sort={sort} dir={dir} onSort={applySort} />
                  <th>Salesperson</th>
                  <SortHeader label="Status" column="status" sort={sort} dir={dir} onSort={applySort} />
                  <SortHeader label="Total" column="total" sort={sort} dir={dir} onSort={applySort} align="right" />
                  <SortHeader label="Balance" column="balance" sort={sort} dir={dir} onSort={applySort} align="right" />
                </tr>
              </thead>
              <tbody>
                {data?.rows?.length ? (
                  data.rows.map((inv) => (
                    <tr key={inv.id}>
                      <td>
                        <Link className="link" to={`/invoices/${inv.id}`}>
                          {inv.invoice_number}
                        </Link>
                        {!inv.line_items_synced ? <span className="pill">lines pending</span> : null}
                      </td>
                      <td>{fmtDate(inv.invoice_date)}</td>
                      <td>{fmtDate(inv.due_date)}</td>
                      <td>
                        {inv.customer_id ? (
                          <Link className="link" to={`/customers/${inv.customer_id}`}>
                            {inv.customer_name}
                          </Link>
                        ) : (
                          inv.customer_name || '—'
                        )}
                      </td>
                      <td>{inv.salesperson_name || '—'}</td>
                      <td>
                        <StatusChip value={inv.status} />
                      </td>
                      <td className="right">{inr(inv.total)}</td>
                      <td className={`right ${inv.balance > 0 ? 'money-due' : ''}`}>{inr(inv.balance)}</td>
                    </tr>
                  ))
                ) : (
                  <EmptyRow colSpan={8}>No invoices match these filters.</EmptyRow>
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
