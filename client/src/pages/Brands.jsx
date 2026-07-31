import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../api.js';
import { num, titleCase } from '../format.js';
import { Card, Loading, ErrorBox, EmptyRow, Banner } from '../components/ui.jsx';

const RULE_TYPES = [
  { value: 'category', label: 'Category', hint: 'exact match on the item category' },
  { value: 'name_pattern', label: 'Name pattern', hint: 'use % as a wildcard; no wildcard = "contains"' },
  { value: 'sku_pattern', label: 'SKU pattern', hint: 'use % as a wildcard, e.g. HLM-%' },
  { value: 'custom_field', label: 'Custom field', hint: 'exact match on a named Zoho custom field' },
];

const BLANK_RULE = {
  brand_id: '',
  rule_type: 'category',
  custom_field_name: '',
  match_value: '',
  priority: 100,
};

export default function Brands() {
  const queryClient = useQueryClient();
  const [newBrand, setNewBrand] = useState('');
  const [rule, setRule] = useState(BLANK_RULE);
  const [editingRule, setEditingRule] = useState(null);
  const [search, setSearch] = useState('');

  const brandsQuery = useQuery({ queryKey: ['brands'], queryFn: () => api.get('/brands') });
  const unmappedQuery = useQuery({
    queryKey: ['unmapped-items'],
    queryFn: () => api.get('/brands/unmapped-items?limit=500'),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['brands'] });
    queryClient.invalidateQueries({ queryKey: ['unmapped-items'] });
    queryClient.invalidateQueries({ queryKey: ['performance'] });
  };

  const createBrand = useMutation({ mutationFn: (body) => api.post('/brands', body), onSuccess: refresh });
  const patchBrand = useMutation({
    mutationFn: ({ id, ...body }) => api.put(`/brands/${id}`, body),
    onSuccess: refresh,
  });
  const createRule = useMutation({ mutationFn: (body) => api.post('/brands/rules', body), onSuccess: refresh });
  const patchRule = useMutation({
    mutationFn: ({ id, ...body }) => api.put(`/brands/rules/${id}`, body),
    onSuccess: refresh,
  });
  const dropRule = useMutation({ mutationFn: (id) => api.del(`/brands/rules/${id}`), onSuccess: refresh });
  const remap = useMutation({ mutationFn: () => api.post('/brands/remap'), onSuccess: refresh });
  const assignItem = useMutation({
    mutationFn: ({ id, brand_id }) => api.put(`/items/${encodeURIComponent(id)}/brand`, { brand_id }),
    onSuccess: refresh,
  });

  if (brandsQuery.isLoading) return <Loading />;
  if (brandsQuery.error) return <ErrorBox error={brandsQuery.error} />;

  const { brands = [], rules = [], stats = {} } = brandsQuery.data || {};
  const activeBrands = brands.filter((b) => b.is_active);
  const unmapped = unmappedQuery.data?.rows || [];
  const visibleUnmapped = search
    ? unmapped.filter((i) => `${i.name} ${i.sku || ''} ${i.category_name || ''}`.toLowerCase().includes(search.toLowerCase()))
    : unmapped;

  const mutationError =
    createBrand.error || patchBrand.error || createRule.error || patchRule.error || dropRule.error || assignItem.error;

  function submitRule(e) {
    e.preventDefault();
    const payload = {
      brand_id: Number(rule.brand_id),
      rule_type: rule.rule_type,
      match_value: rule.match_value.trim(),
      priority: Number(rule.priority) || 100,
      custom_field_name: rule.rule_type === 'custom_field' ? rule.custom_field_name.trim() : null,
    };
    if (!payload.brand_id || !payload.match_value) return;
    createRule.mutate(payload, { onSuccess: () => setRule({ ...BLANK_RULE, brand_id: rule.brand_id }) });
  }

  function saveEditedRule() {
    const r = editingRule;
    patchRule.mutate(
      {
        id: r.id,
        brand_id: Number(r.brand_id),
        rule_type: r.rule_type,
        match_value: String(r.match_value).trim(),
        priority: Number(r.priority) || 100,
        custom_field_name: r.rule_type === 'custom_field' ? r.custom_field_name || null : null,
      },
      { onSuccess: () => setEditingRule(null) }
    );
  }

  /** Swap this rule's priority with its neighbour's, then re-materialize. */
  function move(index, delta) {
    const target = rules[index + delta];
    const current = rules[index];
    if (!target) return;
    api
      .put('/brands/rules/reorder', {
        order: [
          { id: current.id, priority: target.priority },
          { id: target.id, priority: current.priority },
        ],
      })
      .then(refresh);
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Brands</h1>
        <p className="page-sub">
          Items are mapped to brands by the ordered rules below — the first rule that matches wins. A manual
          assignment always beats the rules and is never overwritten by a re-run.
        </p>
      </header>

      <ErrorBox error={mutationError} />

      <div className="kpi-row">
        <div className="kpi">
          <div className="kpi-label">Items</div>
          <div className="kpi-value">{num(stats.items)}</div>
          <div className="kpi-sub">synced from Zoho</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Mapped</div>
          <div className="kpi-value">{num(stats.mapped)}</div>
          <div className="kpi-sub">{num(stats.manual)} set by hand</div>
        </div>
        <div className={`kpi ${stats.unmapped ? 'due' : ''}`}>
          <div className="kpi-label">Unmapped</div>
          <div className="kpi-value">{num(stats.unmapped)}</div>
          <div className="kpi-sub">excluded from brand rollups</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Rules</div>
          <div className="kpi-value">{num(rules.length)}</div>
          <div className="kpi-sub">{num(brands.length)} brands</div>
        </div>
      </div>

      <Card
        title="Brands"
        actions={
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (newBrand.trim()) createBrand.mutate({ name: newBrand.trim() }, { onSuccess: () => setNewBrand('') });
            }}
          >
            <input
              type="text"
              placeholder="New brand name"
              value={newBrand}
              onChange={(e) => setNewBrand(e.target.value)}
            />
            <button type="submit" className="btn" disabled={createBrand.isPending || !newBrand.trim()}>
              Add brand
            </button>
          </form>
        }
      >
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Brand</th>
                <th className="right">Items</th>
                <th className="right">Manual</th>
                <th className="right">Rules</th>
                <th>Active</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {brands.length ? (
                brands.map((b) => (
                  <BrandRow key={b.id} brand={b} onSave={(patch) => patchBrand.mutate({ id: b.id, ...patch })} />
                ))
              ) : (
                <EmptyRow colSpan={6}>No brands yet — add one above, then give it a rule.</EmptyRow>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title="Rules"
        actions={
          <button type="button" className="btn" onClick={() => remap.mutate()} disabled={remap.isPending}>
            {remap.isPending ? 'Re-running…' : 'Re-run mapping'}
          </button>
        }
      >
        {remap.data ? (
          <Banner tone="info">
            Re-ran {num(remap.data.remap.rules)} rules over {num(remap.data.remap.evaluated)} items ·{' '}
            {num(remap.data.remap.changed)} mapping(s) changed · {num(remap.data.remap.manual)} manual override(s)
            left alone.
          </Banner>
        ) : null}

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th className="right">Priority</th>
                <th>Order</th>
                <th>Brand</th>
                <th>Type</th>
                <th>Match</th>
                <th className="right">Items</th>
                <th>Active</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rules.length ? (
                rules.map((r, index) =>
                  editingRule && editingRule.id === r.id ? (
                    <tr key={r.id} className="editing">
                      <td className="right">
                        <input
                          className="cell-input tiny"
                          type="number"
                          value={editingRule.priority}
                          onChange={(e) => setEditingRule({ ...editingRule, priority: e.target.value })}
                        />
                      </td>
                      <td />
                      <td>
                        <select
                          value={editingRule.brand_id}
                          onChange={(e) => setEditingRule({ ...editingRule, brand_id: e.target.value })}
                        >
                          {brands.map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <select
                          value={editingRule.rule_type}
                          onChange={(e) => setEditingRule({ ...editingRule, rule_type: e.target.value })}
                        >
                          {RULE_TYPES.map((t) => (
                            <option key={t.value} value={t.value}>
                              {t.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        {editingRule.rule_type === 'custom_field' ? (
                          <input
                            className="cell-input"
                            placeholder="field name"
                            value={editingRule.custom_field_name || ''}
                            onChange={(e) => setEditingRule({ ...editingRule, custom_field_name: e.target.value })}
                          />
                        ) : null}
                        <input
                          className="cell-input"
                          value={editingRule.match_value}
                          onChange={(e) => setEditingRule({ ...editingRule, match_value: e.target.value })}
                        />
                      </td>
                      <td />
                      <td>
                        <label className="check">
                          <input
                            type="checkbox"
                            checked={Boolean(editingRule.is_active)}
                            onChange={(e) => setEditingRule({ ...editingRule, is_active: e.target.checked })}
                          />
                        </label>
                      </td>
                      <td className="right nowrap">
                        <button type="button" className="btn small" onClick={saveEditedRule} disabled={patchRule.isPending}>
                          Save
                        </button>
                        <button type="button" className="btn ghost small" onClick={() => setEditingRule(null)}>
                          Cancel
                        </button>
                      </td>
                    </tr>
                  ) : (
                    <tr key={r.id} className={r.is_active && r.brand_is_active ? '' : 'row-muted'}>
                      <td className="right mono">{r.priority}</td>
                      <td className="nowrap">
                        <button
                          type="button"
                          className="btn ghost small"
                          disabled={index === 0}
                          onClick={() => move(index, -1)}
                          title="Higher precedence"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="btn ghost small"
                          disabled={index === rules.length - 1}
                          onClick={() => move(index, 1)}
                          title="Lower precedence"
                        >
                          ↓
                        </button>
                      </td>
                      <td>{r.brand_name}</td>
                      <td>{titleCase(r.rule_type)}</td>
                      <td className="mono">
                        {r.rule_type === 'custom_field' && r.custom_field_name ? `${r.custom_field_name} = ` : ''}
                        {r.match_value}
                      </td>
                      <td className="right">{num(r.item_count)}</td>
                      <td>{r.is_active ? 'Yes' : 'No'}</td>
                      <td className="right nowrap">
                        <button
                          type="button"
                          className="btn ghost small"
                          onClick={() => setEditingRule({ ...r, is_active: Boolean(r.is_active) })}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn danger ghost small"
                          onClick={() => dropRule.mutate(r.id)}
                          disabled={dropRule.isPending}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  )
                )
              ) : (
                <EmptyRow colSpan={8}>No rules yet — every item stays unmapped until one matches.</EmptyRow>
              )}
            </tbody>
          </table>
        </div>

        <form className="rule-form" onSubmit={submitRule}>
          <label>
            Brand
            <select value={rule.brand_id} onChange={(e) => setRule({ ...rule, brand_id: e.target.value })} required>
              <option value="">Choose…</option>
              {activeBrands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Rule type
            <select value={rule.rule_type} onChange={(e) => setRule({ ...rule, rule_type: e.target.value })}>
              {RULE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          {rule.rule_type === 'custom_field' ? (
            <label>
              Field name
              <input
                type="text"
                placeholder="Brand"
                value={rule.custom_field_name}
                onChange={(e) => setRule({ ...rule, custom_field_name: e.target.value })}
                required
              />
            </label>
          ) : null}
          <label>
            Match value
            <input
              type="text"
              placeholder={RULE_TYPES.find((t) => t.value === rule.rule_type)?.hint}
              value={rule.match_value}
              onChange={(e) => setRule({ ...rule, match_value: e.target.value })}
              required
            />
          </label>
          <label>
            Priority
            <input
              type="number"
              min="0"
              value={rule.priority}
              onChange={(e) => setRule({ ...rule, priority: e.target.value })}
            />
          </label>
          <button type="submit" className="btn" disabled={createRule.isPending}>
            Add rule
          </button>
        </form>
        <p className="muted-text">
          Lower priority numbers are evaluated first. Patterns accept <code>%</code> as a wildcard; a match value
          with no wildcard is treated as “contains” for name/SKU rules and as an exact match for category and
          custom-field rules.
        </p>
      </Card>

      <Card
        title={`Unmapped items · ${num(unmappedQuery.data?.total || 0)}`}
        actions={
          <input
            type="search"
            placeholder="Filter…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        }
      >
        <p className="muted-text">
          These items match no rule, so their revenue lands in the “Unmapped” bucket on every brand rollup. Assign
          one by hand below, or add a rule that covers it.
        </p>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>SKU</th>
                <th>Category</th>
                <th>Assign brand</th>
              </tr>
            </thead>
            <tbody>
              {visibleUnmapped.length ? (
                visibleUnmapped.map((item) => (
                  <tr key={item.id}>
                    <td>{item.name}</td>
                    <td className="mono">{item.sku || '—'}</td>
                    <td>{item.category_name || '—'}</td>
                    <td>
                      <select
                        value=""
                        disabled={assignItem.isPending}
                        onChange={(e) =>
                          e.target.value && assignItem.mutate({ id: item.id, brand_id: Number(e.target.value) })
                        }
                      >
                        <option value="">Choose brand…</option>
                        {activeBrands.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))
              ) : (
                <EmptyRow colSpan={4}>
                  {unmappedQuery.isLoading ? 'Loading…' : 'Every item is mapped to a brand.'}
                </EmptyRow>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function BrandRow({ brand, onSave }) {
  const [name, setName] = useState(brand.name);
  const dirty = name.trim() && name.trim() !== brand.name;

  return (
    <tr className={brand.is_active ? '' : 'row-muted'}>
      <td>
        <span className="brand-swatch" style={{ background: brand.color || '#c8cfd8' }} />
        <input className="cell-input" value={name} onChange={(e) => setName(e.target.value)} />
      </td>
      <td className="right">{num(brand.item_count)}</td>
      <td className="right">{num(brand.manual_count)}</td>
      <td className="right">{num(brand.rule_count)}</td>
      <td>
        <label className="check">
          <input
            type="checkbox"
            checked={Boolean(brand.is_active)}
            onChange={(e) => onSave({ is_active: e.target.checked })}
          />
          {brand.is_active ? 'Active' : 'Off'}
        </label>
      </td>
      <td className="right">
        <button type="button" className="btn small" disabled={!dirty} onClick={() => onSave({ name: name.trim() })}>
          Rename
        </button>
      </td>
    </tr>
  );
}
