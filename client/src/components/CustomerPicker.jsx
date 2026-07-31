import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '../api.js';
import { inr0, fmtDate, qs } from '../format.js';

/**
 * Searchable customer picker, shared by the focus plan and the cheque forms.
 *
 * Deliberately a plain input + result list rather than a popover: it has to work
 * inside a table row, inside a form, and inside a modal-less "add" panel, and a
 * list that is simply there is easier to reason about than one that appears.
 *
 * Every result row carries outstanding + last invoice date — the two numbers the
 * admin is actually deciding on when picking who to chase this month.
 */
function useCustomerSearch(term) {
  return useQuery({
    queryKey: ['customer-search', term],
    queryFn: () => api.get(`/customers${qs({ search: term, per_page: 12, sort: 'outstanding', dir: 'DESC' })}`),
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });
}

export function CustomerSearch({
  onPick,
  exclude = [],
  selectedIds = [],
  placeholder = 'Search customers by name, company or mobile…',
  autoFocus = false,
  emptyHint = 'Type to search, or pick from the biggest outstanding balances below.',
}) {
  const [term, setTerm] = useState('');
  const { data, isFetching } = useCustomerSearch(term.trim());
  const excluded = useMemo(() => new Set(exclude), [exclude]);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const rows = (data?.rows || []).filter((c) => !excluded.has(c.id));

  return (
    <div className="picker">
      <input
        className="picker-input"
        type="search"
        value={term}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => setTerm(e.target.value)}
      />
      <div className="picker-results">
        {rows.length ? (
          rows.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`picker-row ${selected.has(c.id) ? 'on' : ''}`}
              onClick={() => onPick(c)}
            >
              <span className="picker-name">
                {c.contact_name}
                {c.company_name && c.company_name !== c.contact_name ? (
                  <em className="picker-company">{c.company_name}</em>
                ) : null}
              </span>
              <span className="picker-meta">
                {c.effective_rep_name || 'Unattributed'} · last invoice {fmtDate(c.last_invoice_date)}
              </span>
              <span className={`picker-amount ${c.outstanding_receivable > 0 ? 'money-due' : ''}`}>
                {inr0(c.outstanding_receivable)}
              </span>
              {selected.has(c.id) ? <span className="chip info">Selected</span> : null}
            </button>
          ))
        ) : (
          <div className="picker-empty">{isFetching ? 'Searching…' : term ? 'No customers match that.' : emptyHint}</div>
        )}
      </div>
    </div>
  );
}

/**
 * Single-value picker for a form field: shows the chosen customer with a
 * "Change" button, and the search list until one is chosen.
 */
export function CustomerField({ value, name, onChange, label = 'Customer', locked = false }) {
  const [open, setOpen] = useState(!value);
  useEffect(() => {
    if (value) setOpen(false);
  }, [value]);

  if (locked && value) {
    return (
      <label className="picker-field">
        <span>{label}</span>
        <div className="picker-chosen">
          <strong>{name || value}</strong>
        </div>
      </label>
    );
  }

  return (
    <div className="picker-field">
      <span className="picker-label">{label}</span>
      {value && !open ? (
        <div className="picker-chosen">
          <strong>{name || value}</strong>
          <button type="button" className="btn ghost small" onClick={() => setOpen(true)}>
            Change
          </button>
        </div>
      ) : (
        <CustomerSearch
          onPick={(c) => {
            onChange(c.id, c.contact_name);
            setOpen(false);
          }}
          emptyHint="Search for the customer this cheque came from."
        />
      )}
    </div>
  );
}

export default CustomerSearch;
