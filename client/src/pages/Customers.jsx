import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import api from '../api.js';
import { inr, fmtDate, qs } from '../format.js';
import { Card, Loading, ErrorBox, EmptyRow, Pagination, SortHeader } from '../components/ui.jsx';

export default function Customers() {
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [withOutstanding, setWithOutstanding] = useState(false);
  const [sort, setSort] = useState('name');
  const [dir, setDir] = useState('ASC');
  const [page, setPage] = useState(1);
  const perPage = 25;

  const query = qs({
    search: term,
    with_outstanding: withOutstanding ? '1' : '',
    sort,
    dir,
    page,
    per_page: perPage,
  });

  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ['customers', query],
    queryFn: () => api.get(`/customers${query}`),
    placeholderData: keepPreviousData,
  });

  function applySort(column, nextDir) {
    setSort(column);
    setDir(nextDir);
    setPage(1);
  }

  function submitSearch(e) {
    e.preventDefault();
    setTerm(search.trim());
    setPage(1);
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Customers</h1>
        <p className="page-sub">Synced from Zoho Books contacts (customers only).</p>
      </header>

      <Card
        title={`Customers${data ? ` · ${data.total.toLocaleString('en-IN')}` : ''}`}
        actions={
          <form className="filters" onSubmit={submitSearch}>
            <input
              type="search"
              placeholder="Search name, company, mobile, email…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <label className="check">
              <input
                type="checkbox"
                checked={withOutstanding}
                onChange={(e) => {
                  setWithOutstanding(e.target.checked);
                  setPage(1);
                }}
              />
              Outstanding only
            </label>
            <button type="submit" className="btn">
              Search
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
                  <SortHeader label="Customer" column="name" sort={sort} dir={dir} onSort={applySort} />
                  <SortHeader label="Mobile" column="mobile" sort={sort} dir={dir} onSort={applySort} />
                  <th className="right">Invoices</th>
                  <SortHeader
                    label="Outstanding"
                    column="outstanding"
                    sort={sort}
                    dir={dir}
                    onSort={applySort}
                    align="right"
                  />
                  <SortHeader
                    label="Last invoice"
                    column="last_invoice_date"
                    sort={sort}
                    dir={dir}
                    onSort={applySort}
                  />
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data?.rows?.length ? (
                  data.rows.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <Link className="link" to={`/customers/${c.id}`}>
                          {c.contact_name}
                        </Link>
                        {c.company_name && c.company_name !== c.contact_name ? (
                          <div className="sub">{c.company_name}</div>
                        ) : null}
                      </td>
                      <td>{c.mobile || c.phone || '—'}</td>
                      <td className="right">{c.invoice_count ?? 0}</td>
                      <td className={`right ${c.outstanding_receivable > 0 ? 'money-due' : ''}`}>
                        {inr(c.outstanding_receivable)}
                      </td>
                      <td>{fmtDate(c.last_invoice_date)}</td>
                      <td>{c.status || '—'}</td>
                    </tr>
                  ))
                ) : (
                  <EmptyRow colSpan={6}>No customers match this filter.</EmptyRow>
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
