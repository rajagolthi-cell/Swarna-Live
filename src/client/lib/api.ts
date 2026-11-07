// Same-origin API client. The session cookie is HttpOnly (JavaScript never sees it);
// the CSRF token is kept in memory and sent on every change.

let csrfToken = '';
export const setCsrf = (t: string | undefined | null) => { if (t) csrfToken = t; };

export class ApiError extends Error {
  constructor(public status: number, message: string, public code: string, public data: Record<string, unknown>) {
    super(message);
  }
}

type Listener = (e: ApiError) => void;
const listeners = new Set<Listener>();
/** Notified about session-level errors (signed out / profile locked) from any request. */
export const onSessionError = (l: Listener) => { listeners.add(l); return () => { listeners.delete(l); }; };

async function request<T>(method: string, path: string, body?: unknown, raw?: Blob): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
  if (raw) headers['Content-Type'] = raw.type;
  else if (body !== undefined || method !== 'GET') headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: raw ?? (method === 'GET' ? undefined : JSON.stringify(body ?? {})), credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'Cannot reach Swarna Live. Check the internet connection and try again.', 'NETWORK', {});
  }
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json().catch(() => ({})) : {};
  if (data && typeof data.csrf_token === 'string') setCsrf(data.csrf_token);
  if (!res.ok) {
    const err = new ApiError(res.status, data.error || `Request failed (${res.status})`, data.code || 'ERROR', data);
    if (['NOT_SIGNED_IN', 'PROFILE_LOCKED', 'PIN_CHANGE_REQUIRED'].includes(err.code)) listeners.forEach((l) => l(err));
    throw err;
  }
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, b?: unknown) => request<T>('POST', p, b),
  put: <T>(p: string, b?: unknown) => request<T>('PUT', p, b),
  del: <T>(p: string) => request<T>('DELETE', p),
  upload: <T>(p: string, blob: Blob) => request<T>('POST', p, undefined, blob),
};

// ---- shared response types ----

export interface Me {
  authenticated: boolean;
  setup_available?: boolean;
  csrf_token?: string;
  business?: { id: string; name: string; has_logo: boolean };
  owner_email?: string;
  profile_lock_minutes?: number;
  staff?: { id: string; name: string; role: 'owner' | 'admin' | 'employee'; permissions: string[]; pin_must_change: boolean } | null;
  locked_reason?: 'inactive' | 'revoked' | null;
  recent_owner_auth?: boolean;
}

export interface Rate { id: string; metal: 'gold' | 'silver'; rate_paise: number; created_by_name: string; created_at: number }

export interface QuoteListItem {
  id: string; order_no: string; created_at: number; staff_name: string; customer_name: string; customer_phone?: string;
  metal: 'gold' | 'silver'; purity: string; item_type?: string; net_mg: number; offer_paise: number; status: 'estimated' | 'accepted' | 'cancelled';
}

export interface Quote extends QuoteListItem {
  customer_phone: string; item_type: string; description: string | null; gross_mg: number; deduction_mg: number;
  rate_version_id: string; base_rate_paise: number; applied_rate_paise: number; assessed_paise: number; pct_bp: number;
  pct_override: number; override_reason: string | null; notes: string | null; photo_id: string; photo_url: string; draft_ref: string;
  staff_id: string; updated_at: number;
}

export interface AuditEntry { id?: string; staff_name: string | null; action: string; reason: string | null; before_json: string | null; after_json: string | null; created_at: number; entity_type?: string | null }

export interface SyncJob { kind: 'drive' | 'sheet'; status: 'pending' | 'synced' | 'failed' | 'paused'; attempts: number; last_error: string | null; drive_link: string | null; synced_at: number | null }
