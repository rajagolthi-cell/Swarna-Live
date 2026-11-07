// Staff roles and the permissions an owner can grant.

export type Role = 'owner' | 'admin' | 'employee';

export const PERMISSIONS = {
  'quotes.create': 'Create buyback quotes',
  'quotes.view_all': 'See all staff members’ transactions (otherwise only their own)',
  'quotes.update_status': 'Mark quotes Accepted or Cancelled',
  'quotes.correct': 'Correct customer and item details on saved quotes',
  'quotes.export': 'Export transactions to CSV',
  'rates.update': 'Change the business-entered gold and silver rates',
  'settings.business': 'Edit business name, contact details and logo',
  'dashboard.metrics': 'See business totals on the dashboard',
  'audit.view': 'See the full audit history',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/** Employees can only be given transaction-level permissions (plus rates if the owner chooses). */
export const GRANTABLE: Record<Exclude<Role, 'owner'>, Permission[]> = {
  admin: ALL_PERMISSIONS,
  employee: ['quotes.create', 'quotes.view_all', 'quotes.update_status', 'quotes.correct', 'rates.update'],
};

export const DEFAULT_PERMISSIONS: Record<Exclude<Role, 'owner'>, Permission[]> = {
  admin: ['quotes.create', 'quotes.view_all'],
  employee: ['quotes.create'],
};

export function effectivePermissions(role: Role, granted: string[]): Permission[] {
  if (role === 'owner') return ALL_PERMISSIONS;
  const allowed = GRANTABLE[role];
  return allowed.filter((p) => granted.includes(p));
}

export const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', admin: 'Admin', employee: 'Employee' };

export const STATUSES = ['estimated', 'accepted', 'cancelled'] as const;
export type QuoteStatus = (typeof STATUSES)[number];
export const STATUS_LABEL: Record<QuoteStatus, string> = {
  estimated: 'Estimated', accepted: 'Accepted (not a payment)', cancelled: 'Cancelled',
};
