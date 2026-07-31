import { useQuery } from '@tanstack/react-query';
import { Navigate, useLocation } from 'react-router-dom';
import { auth } from '../api.js';

/** Wraps the authenticated shell: resolves /api/auth/me, bounces to /login if null. */
export default function RequireAuth({ children }) {
  const location = useLocation();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: auth.me,
    staleTime: 60_000,
    retry: false,
  });

  if (isLoading) return <div className="page-loading">Loading…</div>;

  if (isError || !data?.user) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }

  return children;
}
