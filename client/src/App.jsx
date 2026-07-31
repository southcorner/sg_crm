import { Routes, Route, Navigate } from 'react-router-dom';
import Layout, { NAV_ITEMS } from './components/Layout.jsx';
import RequireAuth from './components/RequireAuth.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Placeholder from './pages/Placeholder.jsx';

// Every nav destination except the dashboard is a stub until its phase lands.
const stubRoutes = NAV_ITEMS.filter((item) => item.to !== '/');

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Dashboard />} />
        {stubRoutes.map((item) => (
          <Route
            key={item.to}
            path={item.to}
            element={<Placeholder title={item.label} phase={item.phase} />}
          />
        ))}
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
