import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../api.js';
import { inr, inr0, qs } from '../format.js';
import { Card, Loading, ErrorBox, EmptyRow, Banner, MonthPicker } from '../components/ui.jsx';
import { monthLabel } from '../charts.js';

function thisMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const cellKey = (repId, brandId) => `${repId}|${brandId ?? 'all'}`;

export default function Targets() {
  const queryClient = useQueryClient();
  const [month, setMonth] = useState(thisMonth());
  const [draft, setDraft] = useState({});
  const [dirty, setDirty] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['targets', month],
    queryFn: () => api.get(`/targets${qs({ month })}`),
  });

  const save = useMutation({
    mutationFn: (rows) => api.put('/targets', { month, rows }),
    onSuccess: () => {
      setDirty(false);
      queryClient.invalidateQueries({ queryKey: ['targets'] });
      queryClient.invalidateQueries({ queryKey: ['performance'] });
    },
  });

  // reload the grid whenever the server data (i.e. the month) changes
  const serverDraft = useMemo(() => {
    const out = {};
    for (const row of data?.rows || []) out[cellKey(row.salesperson_id, row.brand_id)] = String(row.target_amount);
    return out;
  }, [data]);

  useEffect(() => {
    setDraft(serverDraft);
    setDirty(false);
  }, [serverDraft]);

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;

  const reps = data?.reps || [];
  const brands = data?.brands || [];
  const columns = [{ id: null, name: 'Overall' }, ...brands.map((b) => ({ id: b.id, name: b.name }))];

  const setCell = (repId, brandId, value) => {
    setDraft((d) => ({ ...d, [cellKey(repId, brandId)]: value }));
    setDirty(true);
  };
  const cellValue = (repId, brandId) => draft[cellKey(repId, brandId)] ?? '';

  const columnTotal = (brandId) =>
    reps.reduce((sum, r) => sum + (Number(draft[cellKey(r.id, brandId)]) || 0), 0);

  function submit() {
    const rows = [];
    for (const rep of reps) {
      for (const col of columns) {
        const raw = draft[cellKey(rep.id, col.id)];
        const amount = Number(raw) || 0;
        const existed = serverDraft[cellKey(rep.id, col.id)] !== undefined;
        // only send cells that exist server-side or now carry a value —
        // no point writing (and immediately deleting) thousands of empty cells
        if (!existed && !amount) continue;
        rows.push({ salesperson_id: rep.id, brand_id: col.id, target_amount: amount });
      }
    }
    save.mutate(rows);
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Targets</h1>
        <p className="page-sub">
          Monthly sales targets per rep. The <strong>Overall</strong> column is the rep’s total target; brand columns
          are optional sub-targets. Clear a cell to remove that target.
        </p>
      </header>

      <div className="filter-bar">
        <MonthPicker value={month} onChange={(v) => v && setMonth(v)} />
        <div className="spacer" />
        {dirty ? <span className="form-error">Unsaved changes</span> : null}
        {save.isSuccess && !dirty ? <span className="form-ok">Saved.</span> : null}
        <button type="button" className="btn" onClick={submit} disabled={save.isPending || !dirty}>
          {save.isPending ? 'Saving…' : 'Save targets'}
        </button>
      </div>

      <ErrorBox error={save.error} />
      {!brands.length ? (
        <Banner tone="info">
          No active brands yet — only the overall target column is available. Add brands on the Brands page to set
          per-brand targets.
        </Banner>
      ) : null}

      <Card title={`Target grid · ${monthLabel(month)}`}>
        <div className="table-wrap">
          <table className="data-table targets-grid">
            <thead>
              <tr>
                <th>Rep</th>
                {columns.map((c) => (
                  <th key={c.id ?? 'all'} className="right">
                    {c.name}
                  </th>
                ))}
                <th className="right">Achieved</th>
              </tr>
            </thead>
            <tbody>
              {reps.length ? (
                reps.map((rep) => (
                  <tr key={rep.id} className={rep.is_active ? '' : 'row-muted'}>
                    <td>
                      {rep.name}
                      {rep.is_active ? null : <span className="sub">inactive</span>}
                    </td>
                    {columns.map((c) => (
                      <td key={c.id ?? 'all'} className="right">
                        <input
                          className="cell-input money"
                          type="number"
                          min="0"
                          step="1000"
                          placeholder="0"
                          value={cellValue(rep.id, c.id)}
                          onChange={(e) => setCell(rep.id, c.id, e.target.value)}
                        />
                      </td>
                    ))}
                    <td className="right">{inr(rep.sales)}</td>
                  </tr>
                ))
              ) : (
                <EmptyRow colSpan={columns.length + 2}>
                  No salespersons synced yet — run a Zoho sync first.
                </EmptyRow>
              )}
            </tbody>
            {reps.length ? (
              <tfoot>
                <tr>
                  <th>Total</th>
                  {columns.map((c) => (
                    <th key={c.id ?? 'all'} className="right">
                      {inr0(columnTotal(c.id))}
                    </th>
                  ))}
                  <th className="right">{inr0(reps.reduce((s, r) => s + (r.sales || 0), 0))}</th>
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
        <p className="muted-text">
          “Achieved” is this month’s sales for the rep, attributed the same way as the Performance page. Brand
          sub-targets do not have to add up to the overall target.
        </p>
      </Card>
    </div>
  );
}
