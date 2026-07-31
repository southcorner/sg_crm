import { Routes, Route, Navigate } from 'react-router-dom';
import Layout, { NAV_ITEMS } from './components/Layout.jsx';
import RequireAuth from './components/RequireAuth.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Customers from './pages/Customers.jsx';
import CustomerDetail from './pages/CustomerDetail.jsx';
import Invoices from './pages/Invoices.jsx';
import InvoiceDetail from './pages/InvoiceDetail.jsx';
import Payments from './pages/Payments.jsx';
import Settings from './pages/Settings.jsx';
import Placeholder from './pages/Placeholder.jsx';

// Routes built in phase 1; everything else in the nav is still a stub.
const BUILT = new Set(['/', '/customers', '/invoices', '/payments', '/settings']);
const stubRoutes = NAV_ITEMS.filter((item) => !BUILT.has(item.to));

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
        <Route path="/customers" element={<Customers />} />
        <Route path="/customers/:id" element={<CustomerDetail />} />
        <Route path="/invoices" element={<Invoices />} />
        <Route path="/invoices/:id" element={<InvoiceDetail />} />
        <Route path="/payments" element={<Payments />} />
        <Route path="/settings" element={<Settings />} />
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
