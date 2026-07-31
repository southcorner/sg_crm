import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import api, { auth } from '../api.js';

// The full page map from the plan. Pages land phase by phase; until then their
// route renders a placeholder.
export const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', phase: 1 },
  { to: '/customers', label: 'Customers', phase: 1 },
  { to: '/invoices', label: 'Invoices', phase: 1 },
  { to: '/payments', label: 'Payments', phase: 1 },
  { to: '/performance', label: 'Performance', phase: 2 },
  { to: '/brands', label: 'Brands', phase: 2 },
  { to: '/targets', label: 'Targets', phase: 2 },
  { to: '/focus', label: 'Focus Plan', phase: 3 },
  { to: '/dormant', label: 'Dormant', phase: 3 },
  { to: '/cheques', label: 'Cheques', phase: 3 },
  { to: '/reminders', label: 'Reminders', phase: 4 },
  { to: '/reps', label: 'Reps', phase: 2 },
  { to: '/settings', label: 'Settings', phase: 1 },
];

export default function Layout() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  async function handleLogout() {
    try {
      await auth.logout();
    } finally {
      queryClient.clear();
      navigate('/login', { replace: true });
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">SG CRM</div>
        <nav className="sidebar-nav">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <RepScopeIndicator />
        <button type="button" className="logout-btn" onClick={handleLogout}>
          Log out
        </button>
      </aside>

      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}

/**
 * Standing reminder that the CRM is filtered to a subset of reps, so a short
 * customer list or a small MTD number is never mistaken for missing data.
 * Silent when every rep is visible.
 */
function RepScopeIndicator() {
  const { data } = useQuery({
    queryKey: ['reps'],
    queryFn: () => api.get('/reps'),
    staleTime: 60_000,
  });

  const scope = data?.repScope;
  if (!scope?.active) return null;

  const repsHidden = scope.hidden > 0;
  const unattributedHidden = scope.showUnattributed === false;

  // three shapes: reps only, unattributed only, or both
  const headline = repsHidden
    ? `Showing ${scope.visible} of ${scope.total} reps`
    : 'Unattributed hidden';
  const detail = repsHidden
    ? `${scope.hidden} hidden${unattributedHidden ? ' · unattributed hidden' : ''}`
    : 'Records with no salesperson are filtered out';

  return (
    <Link className="scope-indicator" to="/reps" title="Manage what the CRM operates on">
      <span className="scope-dot" />
      <span>{headline}</span>
      <em>{detail}</em>
    </Link>
  );
}
