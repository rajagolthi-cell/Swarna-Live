import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactElement, type ReactNode, cloneElement, isValidElement } from 'react';
import { formatPaise } from '../../shared/calc';
import { STATUS_LABEL, type QuoteStatus } from '../../shared/permissions';

export function Button({ variant = 'primary', busy, children, className = '', size, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'gold'; busy?: boolean; size?: 'lg' }) {
  return (
    <button className={`btn btn-${variant} ${size === 'lg' ? 'btn-lg' : ''} ${className}`} disabled={busy || rest.disabled} aria-busy={busy || undefined} {...rest}>
      {busy ? <span className="spinner" aria-hidden="true" /> : null}
      <span>{children}</span>
    </button>
  );
}

/** Label + control + help/error text, wired up with ids for screen readers. */
export function Field({ label, help, error, children, optional, prefix }: { label: string; help?: ReactNode; error?: string | null; children: ReactElement; optional?: boolean; prefix?: string }) {
  const id = useId();
  const helpId = `${id}-help`;
  const errId = `${id}-err`;
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
      id, 'aria-invalid': error ? true : undefined,
      'aria-describedby': [help ? helpId : '', error ? errId : ''].filter(Boolean).join(' ') || undefined,
    })
    : children;
  return (
    <div className={`field ${error ? 'has-error' : ''}`}>
      <label htmlFor={id}>{label}{optional ? <span className="optional"> (optional)</span> : null}</label>
      {prefix ? <div className="input-prefix"><span aria-hidden="true">{prefix}</span>{control}</div> : control}
      {help ? <div className="help" id={helpId}>{help}</div> : null}
      {error ? <div className="error-text" id={errId} role="alert">{error}</div> : null}
    </div>
  );
}

export function Alert({ kind = 'info', children }: { kind?: 'info' | 'error' | 'success' | 'warning'; children: ReactNode }) {
  return <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;
}

export function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && ref.current) {
        const items = ref.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        const list = [...items].filter((x) => !x.hasAttribute('disabled'));
        if (!list.length) return;
        if (e.shiftKey && document.activeElement === list[0]) { e.preventDefault(); list[list.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === list[list.length - 1]) { e.preventDefault(); list[0].focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    const first = ref.current?.querySelector<HTMLElement>('[autofocus], input, select, textarea, button');
    first?.focus();
    return () => { document.removeEventListener('keydown', onKey); prev?.focus(); };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p className="muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function StatusBadge({ status }: { status: QuoteStatus }) {
  return <span className={`badge badge-${status}`}>{status === 'accepted' ? 'Accepted' : STATUS_LABEL[status]}</span>;
}

export const Money = ({ paise }: { paise: number }) => <span className="num">{formatPaise(paise)}</span>;

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div className="loading" role="status"><span className="spinner" aria-hidden="true" /> {label}</div>;
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`card ${className}`}>{children}</section>;
}

export function Pagination({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  if (pages <= 1) return null;
  return (
    <nav className="pagination" aria-label="Pages">
      <Button variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>‹ Previous</Button>
      <span aria-live="polite">Page {page} of {pages}</span>
      <Button variant="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next ›</Button>
    </nav>
  );
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong.';
}
