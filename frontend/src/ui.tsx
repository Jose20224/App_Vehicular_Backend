import { useEffect, useRef, useState, type ReactNode, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  CarFront,
  Check,
  ChevronRight,
  FileText,
  Home,
  LifeBuoy,
  MapPin,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  WifiOff,
  Wrench,
  X,
  LoaderCircle,
  type LucideIcon,
} from 'lucide-react';
import { api, ApiError } from './api';
import { useSession } from './session';
export const icons = {
  back: ArrowLeft,
  arrow: ArrowRight,
  bell: Bell,
  car: CarFront,
  check: Check,
  chevron: ChevronRight,
  document: FileText,
  home: Home,
  help: LifeBuoy,
  location: MapPin,
  plus: Plus,
  search: Search,
  settings: Settings,
  shield: ShieldCheck,
  offline: WifiOff,
  workshop: Wrench,
  close: X,
};
export function Icon({ name, size = 22 }: { name: keyof typeof icons; size?: number }) {
  const Component: LucideIcon = icons[name];
  return <Component size={size} strokeWidth={1.8} aria-hidden="true" />;
}
export function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}
export function useApiQuery<T>(path: string, enabled = true) {
  const { user } = useSession();
  return useQuery({
    queryKey: ['api', user?.id ?? 'public', path],
    queryFn: ({ signal }) => api<T>(path, { signal }),
    enabled,
  });
}
export function Page({
  title,
  description,
  children,
  back = true,
  action,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  back?: boolean;
  action?: ReactNode;
}) {
  const navigate = useNavigate();
  useEffect(() => {
    document.title = `${title} · Registro S.A.`;
    window.scrollTo(0, 0);
  }, [title]);
  return (
    <>
      <div className="page-heading">
        {back && (
          <button className="icon-button" aria-label="Volver" onClick={() => navigate(-1)}>
            <Icon name="back" />
          </button>
        )}
        <div>
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </>
  );
}
export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div role="alert" className="notice error">
      <strong>{error instanceof Error ? error.message : 'Ocurrió un error.'}</strong>
      {error instanceof ApiError && error.requestId && <small>Referencia: {error.requestId}</small>}
    </div>
  );
}
export function Loading() {
  return (
    <div role="status" className="loading">
      <LoaderCircle className="spin" size={24} /> Cargando…
    </div>
  );
}
export function Empty({
  title,
  children,
  to,
  label = 'Agregar',
}: {
  title: string;
  children?: ReactNode;
  to?: string;
  label?: string;
}) {
  return (
    <section className="empty">
      <div className="empty-icon">
        <Icon name="car" size={36} />
      </div>
      <h2>{title}</h2>
      <p>{children}</p>
      {to && (
        <Link className="button" to={to}>
          <Icon name="plus" />
          {label}
        </Link>
      )}
    </section>
  );
}
export function Status({ value }: { value?: string | null }) {
  const text: Record<string, string> = {
    vigente: 'Vigente',
    por_vencer: 'Por vencer',
    vencido: 'Vencido',
    disponible: 'Disponible',
    pendiente_subida: 'Sin archivo',
    created: 'Solicitada',
    accepted: 'Aceptada',
    completed: 'Finalizada',
    cancelled: 'Cancelada',
    dispatched: 'Buscando ayuda',
  };
  return (
    <span
      className={`badge ${value === 'vencido' || value === 'cancelled' ? 'red' : value === 'por_vencer' ? 'amber' : 'green'}`}
    >
      {text[value || ''] || value || 'Sin vencimiento'}
    </span>
  );
}
export function Row({
  icon = 'document',
  title,
  subtitle,
  to,
  children,
}: {
  icon?: keyof typeof icons;
  title: string;
  subtitle?: string;
  to?: string;
  children?: ReactNode;
}) {
  const body = (
    <>
      <span className="tile-icon">
        <Icon name={icon} />
      </span>
      <span className="row-text">
        <strong>{title}</strong>
        {subtitle && <small>{subtitle}</small>}
      </span>
      {children}
      {to && <Icon name="chevron" size={18} />}
    </>
  );
  return to ? (
    <Link className="card row" to={to}>
      {body}
    </Link>
  ) : (
    <div className="card row">{body}</div>
  );
}
export function Submit({
  pending,
  children = 'Guardar',
}: {
  pending: boolean;
  children?: ReactNode;
}) {
  return (
    <button type="submit" className="button full" disabled={pending}>
      {pending ? (
        <>
          <LoaderCircle size={18} className="spin" />
          Guardando…
        </>
      ) : (
        children
      )}
    </button>
  );
}
export function useAction() {
  const running = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function run(task: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setPending(true);
    setError(null);
    try {
      await task();
    } catch (e) {
      setError(e);
    } finally {
      running.current = false;
      setPending(false);
    }
  }
  return { pending, error, run };
}
export function formValues(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  return Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
}
export function date(value?: string | null) {
  return value
    ? new Date(`${value.substring(0, 10)}T12:00:00`).toLocaleDateString('es-NI', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : 'Sin fecha';
}
export function Confirm({
  title,
  children,
  confirm,
  close,
  pending,
}: {
  title: string;
  children: ReactNode;
  confirm: () => void;
  close: () => void;
  pending: boolean;
}) {
  const [focus, setFocus] = useState<HTMLButtonElement | null>(null);
  useEffect(() => {
    focus?.focus();
  }, [focus]);
  return (
    <div
      className="modal-backdrop"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !pending) close();
        if (e.key === 'Tab') {
          const buttons =
            e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
          const first = buttons[0];
          const last = buttons[buttons.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last?.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <section
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        className="modal"
      >
        <h2 id="confirm-title">{title}</h2>
        <p>{children}</p>
        <div className="stack">
          <button ref={setFocus} className="button secondary" onClick={close} disabled={pending}>
            Cancelar
          </button>
          <button className="button danger" onClick={confirm} disabled={pending}>
            {pending ? 'Procesando…' : 'Confirmar'}
          </button>
        </div>
      </section>
    </div>
  );
}
