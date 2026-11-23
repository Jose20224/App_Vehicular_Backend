import { useState } from 'react';
import { Link, Route, Routes, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { v7 } from 'uuid';
import { api, deviceId } from '../api';
import { useSession } from '../session';
import { locate } from '../location';
import type { AppNotification, Collection, Contact, Preferences, Profile } from '../models';
import {
  Confirm,
  Empty,
  ErrorNotice,
  formValues,
  Icon,
  Loading,
  Page,
  Row,
  Submit,
  useAction,
  useApiQuery,
  useOnline,
} from '../ui';
export default function SettingsPages({
  view,
}: {
  view?: 'notifications' | 'contacts' | 'reminders';
}) {
  if (view === 'notifications') return <Notifications />;
  if (view === 'contacts') return <Contacts />;
  if (view === 'reminders') return <ReminderPreferences />;
  return (
    <Routes>
      <Route index element={<Settings />} />
      <Route path="cuenta" element={<EditAccount />} />
      <Route path="privacidad" element={<Privacy />} />
      <Route path="sincronizacion" element={<Sync />} />
      <Route path="permisos" element={<Permissions />} />
      <Route path="seguridad" element={<Security />} />
    </Routes>
  );
}
function Settings() {
  const { user, logout } = useSession();
  const action = useAction();
  return (
    <Page title="Mi cuenta" back={false}>
      <section className="profile-card">
        <span className="avatar">{user?.display_name[0]?.toUpperCase()}</span>
        <h2>{user?.display_name}</h2>
        <p>{user?.phone || 'Cuenta verificada'}</p>
        <Link to="/ajustes/cuenta" className="text-button">
          Editar mi perfil
        </Link>
      </section>
      <div className="stack">
        <Row
          icon="bell"
          title="Recordatorios"
          subtitle="Fechas y preferencias de notificación"
          to="/recordatorios"
        />
        <Row
          icon="shield"
          title="Contactos de emergencia"
          subtitle="Tus personas de confianza"
          to="/contactos"
        />
        <Row
          icon="offline"
          title="Almacenamiento y conexión"
          subtitle="Estado de sincronización"
          to="/ajustes/sincronizacion"
        />
        <Row
          icon="settings"
          title="Permisos de la app"
          subtitle="Ubicación y acceso a funciones"
          to="/ajustes/permisos"
        />
        <Row icon="shield" title="Seguridad de la sesión" to="/ajustes/seguridad" />
        <Row icon="document" title="Privacidad y mis datos" to="/ajustes/privacidad" />
      </div>
      <ErrorNotice error={action.error} />
      <button
        className="button secondary full"
        disabled={action.pending}
        onClick={() => void action.run(logout)}
      >
        Cerrar sesión y borrar datos de la sesión
      </button>
      <p className="fine center">Registro S.A. · Versión 0.1.0</p>
    </Page>
  );
}
function EditAccount() {
  const { user, update } = useSession();
  const query = useApiQuery<Profile>('/me');
  const action = useAction();
  const cache = useQueryClient();
  const [saved, setSaved] = useState(false);
  return (
    <Page title="Editar mi cuenta">
      <ErrorNotice error={query.error} />
      <ErrorNotice error={action.error} />
      {saved && (
        <p role="status" className="notice success">
          Tu perfil fue actualizado.
        </p>
      )}
      {query.isPending ? (
        <Loading />
      ) : (
        <form
          className="stack"
          key={query.data?.id}
          onSubmit={(e) => {
            const f = formValues(e);
            void action.run(async () => {
              const next = await api<Profile>('/me', {
                method: 'PATCH',
                body: { display_name: f.display_name, ...(f.email ? { email: f.email } : {}) },
              });
              update(next);
              await cache.invalidateQueries({ queryKey: ['api'] });
              setSaved(true);
            });
          }}
        >
          <label>
            Nombre
            <input
              name="display_name"
              required
              maxLength={120}
              defaultValue={query.data?.display_name || user?.display_name}
            />
          </label>
          <label>
            Correo electrónico
            <input type="email" name="email" defaultValue={query.data?.email || ''} />
          </label>
          <label>
            Teléfono verificado
            <input disabled value={query.data?.phone || user?.phone || ''} />
          </label>
          <Submit pending={action.pending}>Guardar cambios</Submit>
        </form>
      )}
    </Page>
  );
}
function Notifications() {
  const query = useApiQuery<Collection<AppNotification>>('/notifications');
  const action = useAction();
  const cache = useQueryClient();
  return (
    <Page title="Notificaciones">
      <ErrorNotice error={query.error} />
      <ErrorNotice error={action.error} />
      {query.isPending ? (
        <Loading />
      ) : query.data?.items.length ? (
        <div className="stack">
          {query.data.items.map((n) => (
            <article className={`card notification ${n.read_at ? '' : 'unread'}`} key={n.id}>
              <div className="row">
                <span className="tile-icon">
                  <Icon name="bell" />
                </span>
                <h2>{n.title || 'Recordatorio'}</h2>
              </div>
              <p>{n.description || n.body || 'Consulta tus fechas y documentos.'}</p>
              <small>{new Date(n.created_at).toLocaleString('es-NI')}</small>
              {!n.read_at && (
                <button
                  className="text-button"
                  disabled={action.pending}
                  onClick={() =>
                    void action.run(async () => {
                      await api(`/notifications/${n.id}/read`, { method: 'PATCH' });
                      await cache.invalidateQueries({ queryKey: ['api'] });
                    })
                  }
                >
                  Marcar como leída
                </button>
              )}
            </article>
          ))}
        </div>
      ) : (
        !query.error && <Empty title="Estás al día">Tus avisos aparecerán aquí.</Empty>
      )}
    </Page>
  );
}
function Contacts() {
  const query = useApiQuery<Contact[]>('/me/emergency-contacts');
  const action = useAction();
  const cache = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [remove, setRemove] = useState<string>();
  const [id, setId] = useState(() => v7());
  return (
    <Page
      title="Contactos SOS"
      description="Hasta cinco personas de confianza."
      action={
        <button
          className="icon-button"
          aria-label="Agregar contacto"
          onClick={() => setAdding(!adding)}
        >
          <Icon name="plus" />
        </button>
      }
    >
      <ErrorNotice error={query.error} />
      <ErrorNotice error={action.error} />
      {query.isPending ? (
        <Loading />
      ) : query.data?.length ? (
        <div className="stack">
          {query.data.map((c) => (
            <article key={c.id} className="card">
              <div className="row">
                <span className="avatar small">{c.name[0]}</span>
                <div className="row-text">
                  <h2>{c.name}</h2>
                  <small>
                    {c.relationship_label}
                    {c.is_primary ? ' · Principal' : ''}
                  </small>
                </div>
                <button
                  className="icon-button"
                  aria-label={`Eliminar a ${c.name}`}
                  onClick={() => setRemove(c.id)}
                >
                  <Icon name="close" size={18} />
                </button>
              </div>
              <a className="button secondary full" href={`tel:${c.phone_e164 || c.phone}`}>
                Llamar {c.phone_e164 || c.phone}
              </a>
            </article>
          ))}
        </div>
      ) : (
        !query.error && (
          <Empty title="Tu red de confianza">Agrega un contacto para tenerlo siempre a mano.</Empty>
        )
      )}
      {adding && (
        <form
          className="card stack"
          onSubmit={(e) => {
            const f = formValues(e);
            void action.run(async () => {
              await api('/me/emergency-contacts', {
                method: 'POST',
                body: {
                  id,
                  name: f.name,
                  phone_e164: f.phone,
                  relationship_label: f.relationship,
                  is_primary: f.primary === 'on',
                },
              });
              await cache.invalidateQueries({ queryKey: ['api'] });
              setAdding(false);
              setId(v7());
            });
          }}
        >
          <h2>Nuevo contacto</h2>
          <label>
            Nombre
            <input name="name" required maxLength={120} />
          </label>
          <label>
            Relación
            <input name="relationship" maxLength={40} placeholder="Familiar, amistad…" />
          </label>
          <label>
            Teléfono
            <input
              name="phone"
              type="tel"
              required
              pattern="\+[1-9][0-9]{7,14}"
              placeholder="+50588881234"
            />
          </label>
          <label className="checkbox">
            <input name="primary" type="checkbox" />
            Contacto principal
          </label>
          <Submit pending={action.pending}>Guardar contacto</Submit>
        </form>
      )}
      {remove && (
        <Confirm
          title="¿Eliminar contacto?"
          close={() => setRemove(undefined)}
          pending={action.pending}
          confirm={() =>
            void action.run(async () => {
              await api(`/me/emergency-contacts/${remove}`, { method: 'DELETE' });
              await cache.invalidateQueries({ queryKey: ['api'] });
              setRemove(undefined);
            })
          }
        >
          Este contacto dejará de aparecer en tu lista SOS.
        </Confirm>
      )}
    </Page>
  );
}
function ReminderPreferences() {
  const query = useApiQuery<Preferences>('/me/notification-preferences');
  const schedule =
    useApiQuery<Collection<{ id: string; title: string; scheduled_at: string }>>(
      '/reminders/schedule',
    );
  const action = useAction();
  const cache = useQueryClient();
  const [saved, setSaved] = useState(false);
  return (
    <Page title="Tus recordatorios" description="Un aviso a tiempo hace la diferencia.">
      <ErrorNotice error={query.error} />
      <ErrorNotice error={action.error} />
      {saved && (
        <p className="notice success" role="status">
          Preferencias guardadas.
        </p>
      )}
      {query.isPending ? (
        <Loading />
      ) : (
        query.data && (
          <form
            className="stack"
            key={JSON.stringify(query.data)}
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void action.run(async () => {
                await api('/me/notification-preferences', {
                  method: 'PATCH',
                  body: {
                    enabled_offsets: f.getAll('offset').map(Number),
                    preferred_time: f.get('preferred_time'),
                    push_enabled: f.has('push'),
                    local_enabled: f.has('local'),
                    in_app_enabled: f.has('in_app'),
                  },
                });
                await cache.invalidateQueries({ queryKey: ['api'] });
                setSaved(true);
              });
            }}
          >
            <fieldset className="card">
              <legend>¿Cuándo quieres recibir avisos?</legend>
              {[30, 15, 7, 1, 0].map((n) => (
                <label className="checkbox" key={n}>
                  <input
                    name="offset"
                    type="checkbox"
                    value={n}
                    defaultChecked={query.data.enabled_offsets.includes(n)}
                  />
                  {n === 0 ? 'El día del vencimiento' : `${n} días antes`}
                </label>
              ))}
            </fieldset>
            <label>
              Hora de Nicaragua
              <input
                type="time"
                name="preferred_time"
                required
                defaultValue={query.data.preferred_time}
              />
            </label>
            <div className="card stack">
              <label className="checkbox">
                <input name="in_app" type="checkbox" defaultChecked={query.data.in_app_enabled} />
                Centro de notificaciones
              </label>
              <label className="checkbox">
                <input name="push" type="checkbox" defaultChecked={query.data.push_enabled} />
                Notificaciones push
              </label>
              <label className="checkbox">
                <input name="local" type="checkbox" defaultChecked={query.data.local_enabled} />
                Programación local
              </label>
              <small>
                Guardar una preferencia no concede permisos del dispositivo. Push y avisos del
                sistema requieren la integración nativa configurada.
              </small>
            </div>
            <Submit pending={action.pending} />
          </form>
        )
      )}
      <div className="section-heading">
        <h2>Próximos avisos</h2>
      </div>
      <ErrorNotice error={schedule.error} />
      {schedule.data?.items.map((r) => (
        <Row
          key={r.id}
          title={r.title}
          subtitle={new Date(r.scheduled_at).toLocaleString('es-NI')}
        />
      ))}
    </Page>
  );
}
function Privacy() {
  const { purge } = useSession();
  const action = useAction();
  const [confirm, setConfirm] = useState(false);
  const navigate = useNavigate();
  return (
    <Page title="Privacidad y tus datos">
      <section className="card">
        <Icon name="shield" size={36} />
        <h2>Tú tienes el control</h2>
        <p>
          Puedes exportar tus datos o solicitar la eliminación de tu cuenta. Al salir, los datos
          privados de esta sesión se borran del dispositivo.
        </p>
      </section>
      <ErrorNotice error={action.error} />
      <button
        className="button secondary full"
        disabled={action.pending}
        onClick={() =>
          void action.run(async () => {
            const data = await api('/me/export');
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'registro-mis-datos.json';
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 10000);
          })
        }
      >
        Exportar mis datos
      </button>
      <button className="button danger full" onClick={() => setConfirm(true)}>
        Eliminar mi cuenta
      </button>
      {confirm && (
        <Confirm
          title="¿Eliminar tu cuenta permanentemente?"
          close={() => setConfirm(false)}
          pending={action.pending}
          confirm={() =>
            void action.run(async () => {
              await api('/me', { method: 'DELETE' });
              purge();
              navigate('/bienvenida', { replace: true });
            })
          }
        >
          Se revocarán tus sesiones y se anonimizará tu identidad. Esta acción no se puede deshacer.
        </Confirm>
      )}
    </Page>
  );
}
function Sync() {
  const online = useOnline();
  const action = useAction();
  const [status, setStatus] = useState<{ protocol_version: number; supported: boolean } | null>(
    null,
  );
  const cache = useQueryClient();
  return (
    <Page title="Almacenamiento y conexión">
      <section className="card row">
        <span className="tile-icon">
          <Icon name={online ? 'check' : 'offline'} />
        </span>
        <div>
          <h2>{online ? 'Red disponible' : 'Sin conexión'}</h2>
          <p>
            {online
              ? 'Comprueba también la conexión con el servidor.'
              : 'Los cambios necesitan conexión para enviarse.'}
          </p>
        </div>
      </section>
      <ErrorNotice error={action.error} />
      <button
        className="button full"
        disabled={action.pending || !online}
        onClick={() =>
          void action.run(async () => {
            setStatus(await api(`/sync/status?device_id=${deviceId()}&client_version=0.1.0`));
            await cache.invalidateQueries({ queryKey: ['api'] });
          })
        }
      >
        Verificar servidor y actualizar datos
      </button>
      {status && (
        <p role="status" className="notice success">
          Servidor disponible · Protocolo {status.protocol_version} · Dispositivo{' '}
          {status.supported ? 'compatible' : 'no compatible'}.
        </p>
      )}
      <section className="card">
        <h2>Datos de esta sesión</h2>
        <p>
          Puedes consultar los datos ya cargados mientras la app permanezca abierta. Las escrituras
          y documentos adjuntos requieren internet.
        </p>
        <p>
          Al cerrar la sesión se purgan los datos privados. El almacenamiento offline persistente
          cifrado y la cola de mutaciones todavía necesitan su integración nativa.
        </p>
      </section>
    </Page>
  );
}
function Permissions() {
  const action = useAction();
  const [location, setLocation] = useState(false);
  return (
    <Page title="Permisos de la aplicación">
      <Row
        icon="location"
        title="Ubicación"
        subtitle="Para talleres cercanos y solicitudes de auxilio"
      />
      <ErrorNotice error={action.error} />
      {location && <p className="notice success">La ubicación está disponible.</p>}
      <button
        className="button full"
        disabled={action.pending}
        onClick={() =>
          void action.run(async () => {
            await locate();
            setLocation(true);
          })
        }
      >
        Comprobar permiso de ubicación
      </button>
      <section className="card">
        <h2>Documentos</h2>
        <p>
          La selección de archivos se solicita al adjuntar un documento. La app no accede a toda tu
          galería.
        </p>
        <h2>Notificaciones</h2>
        <p>
          La entrega push necesita configurar Firebase y el proyecto nativo. Por ahora puedes
          consultar los avisos dentro de la app.
        </p>
      </section>
    </Page>
  );
}
function Security() {
  return (
    <Page title="Seguridad de tu sesión">
      <section className="card stack">
        <Icon name="shield" size={42} />
        <h2>Credenciales en memoria</h2>
        <p>
          Los tokens de acceso no se guardan en localStorage. Si recargas o cierras la aplicación,
          tendrás que verificar tu teléfono nuevamente.
        </p>
        <p>
          La huella y el PIN de las plantillas aún requieren un almacén seguro nativo. No se
          presenta un bloqueo visual como si protegiera tus documentos.
        </p>
        <Link to="/ajustes/privacidad" className="button secondary">
          Gestionar mis datos
        </Link>
      </section>
    </Page>
  );
}
