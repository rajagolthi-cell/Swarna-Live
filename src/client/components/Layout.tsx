import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { ROLE_LABEL } from '../../shared/permissions';

const NAV = [
  { to: '/', label: 'Dashboard', icon: '◇', end: true },
  { to: '/buyback/new', label: 'New Buyback', icon: '+' },
  { to: '/transactions', label: 'Transactions', icon: '≡' },
  { to: '/employees', label: 'Employees', icon: '☺', ownerOnly: true },
  { to: '/settings', label: 'Settings', icon: '⚙' },
];

export function Brand({ small }: { small?: boolean }) {
  return (
    <span className={`brand ${small ? 'brand-small' : ''}`}>
      <svg viewBox="0 0 64 64" aria-hidden="true" className="brand-mark"><circle cx="32" cy="32" r="17" fill="none" stroke="currentColor" strokeWidth="5" /><path d="M32 20l3.5 8.5L44 32l-8.5 3.5L32 44l-3.5-8.5L20 32l8.5-3.5z" fill="currentColor" /></svg>
      <span className="brand-name">Swarna <em>Live</em></span>
    </span>
  );
}

export function Layout() {
  const { me, isOwner, refresh } = useAuth();
  const navigate = useNavigate();
  const items = NAV.filter((n) => !n.ownerOnly || isOwner).filter((n) => n.to !== '/buyback/new' || me?.staff?.permissions.includes('quotes.create'));
  const switchProfile = async () => {
    await api.post('/staff/lock').catch(() => undefined);
    await refresh();
    navigate('/profiles');
  };
  return (
    <div className="shell">
      <a className="skip-link" href="#main">Skip to content</a>
      <aside className="sidebar" aria-label="Main navigation">
        <div className="sidebar-brand"><Brand /></div>
        <div className="sidebar-business">{me?.business?.name}</div>
        <nav>
          {items.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
              <span className="nav-icon" aria-hidden="true">{n.icon}</span>{n.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="who"><strong>{me?.staff?.name}</strong><span>{me?.staff ? ROLE_LABEL[me.staff.role] : ''}</span></div>
          <button className="btn btn-on-dark" onClick={switchProfile}>Switch profile</button>
        </div>
      </aside>

      <header className="topbar">
        <Brand small />
        <button className="topbar-who" onClick={switchProfile} aria-label={`Signed in as ${me?.staff?.name}. Switch profile`}>
          {me?.staff?.name} <span aria-hidden="true">⇄</span>
        </button>
      </header>

      <main id="main" className="main" tabIndex={-1}>
        <Outlet />
      </main>

      <nav className="tabbar" aria-label="Main navigation">
        {items.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>
            <span className="nav-icon" aria-hidden="true">{n.icon}</span>
            <span>{n.label === 'New Buyback' ? 'New' : n.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
