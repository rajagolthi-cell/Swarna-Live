import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, ReauthProvider, useAuth } from './lib/auth';
import { Layout } from './components/Layout';
import { Loading } from './components/ui';
import { ChangePinPage, InvitePage, LoginPage, ProfilesPage, RecoverPage, SetupPage } from './pages/Auth';
import { DashboardPage, ReceiptPage, TransactionDetailPage, TransactionsPage } from './pages/Transactions';
import { NewBuybackPage } from './pages/NewBuyback';
import { EmployeesPage } from './pages/Employees';
import { SettingsPage } from './pages/Settings';
import './styles.css';

/** Sends people to the right screen for their sign-in state; works on direct loads and refreshes. */
function Gate({ need, children }: { need: 'public' | 'business' | 'staff'; children: ReactNode }) {
  const { me } = useAuth();
  const loc = useLocation();
  if (!me) return <Loading label="Opening Swarna Live…" />;
  if (need === 'public') {
    if (!me.authenticated) {
      if (me.setup_available && loc.pathname === '/login') return <Navigate to="/setup" replace />;
      return <>{children}</>;
    }
    return <Navigate to={me.staff ? '/' : '/profiles'} replace />;
  }
  if (!me.authenticated) return <Navigate to={me.setup_available ? '/setup' : '/login'} replace />;
  if (need === 'business') return <>{children}</>;
  if (!me.staff) return <Navigate to="/profiles" replace />;
  if (me.staff.pin_must_change && loc.pathname !== '/change-pin') return <Navigate to="/change-pin" replace />;
  return <>{children}</>;
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<Gate need="public"><LoginPage /></Gate>} />
      <Route path="/setup" element={<Gate need="public"><SetupPage /></Gate>} />
      <Route path="/setup/invite" element={<Gate need="public"><InvitePage /></Gate>} />
      <Route path="/recover" element={<Gate need="public"><RecoverPage /></Gate>} />
      <Route path="/profiles" element={<Gate need="business"><ProfilesPage /></Gate>} />
      <Route path="/change-pin" element={<Gate need="staff"><ChangePinPage /></Gate>} />
      <Route path="/transactions/:id/receipt" element={<Gate need="staff"><ReceiptPage /></Gate>} />
      <Route element={<Gate need="staff"><Layout /></Gate>}>
        <Route index element={<DashboardPage />} />
        <Route path="/buyback/new" element={<NewBuybackPage />} />
        <Route path="/transactions" element={<TransactionsPage />} />
        <Route path="/transactions/:id" element={<TransactionDetailPage />} />
        <Route path="/employees" element={<EmployeesPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/:section" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ReauthProvider>
          <App />
        </ReauthProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
