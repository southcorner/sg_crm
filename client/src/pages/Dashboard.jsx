import { useQuery } from '@tanstack/react-query';
import api from '../api.js';

/** Empty shell — KPI tiles, sync status and digest status land in later phases. */
export default function Dashboard() {
  const { data: me } = useQuery({ queryKey: ['auth', 'me'], queryFn: () => api.get('/auth/me') });
  const { data: health } = useQuery({ queryKey: ['health'], queryFn: () => api.get('/health') });

  return (
    <div className="page">
      <header className="page-header">
        <h1>Dashboard</h1>
        <p className="page-sub">
          Signed in as <strong>{me?.user?.username ?? '—'}</strong>
        </p>
      </header>

      <section className="card">
        <h2>Skeleton</h2>
        <p>
          Phase 0 is up: database, migrations, admin auth and the app shell. KPIs, sync status and
          digest status appear here once Zoho sync (phase 1) and the reminder engine (phase 4) land.
        </p>
        <dl className="kv">
          <dt>API</dt>
          <dd>{health?.ok ? 'reachable' : 'unknown'}</dd>
          <dt>Environment</dt>
          <dd>{health?.env ?? '—'}</dd>
        </dl>
      </section>
    </div>
  );
}
