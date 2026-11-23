import { useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Share } from '@capacitor/share';
import { v7 } from 'uuid';
import { api } from '../api';
import { locate } from '../location';
import {
  Confirm,
  Empty,
  ErrorNotice,
  formValues,
  Icon,
  Loading,
  Page,
  Row,
  Status,
  Submit,
  useAction,
  useApiQuery,
} from '../ui';
import type { Assistance, CatalogItem, Collection, Vehicle } from '../models';
export default function AssistancePages() {
  return (
    <Routes>
      <Route index element={<Emergency />} />
      <Route path="nueva" element={<RequestForm />} />
      <Route path="historial" element={<History />} />
      <Route path="proveedores" element={<Providers />} />
      <Route path=":id" element={<Tracker />} />
    </Routes>
  );
}
function Emergency() {
  const numbers = useApiQuery<Collection<{ id: string; label: string; phone_number: string }>>(
    '/catalogs/emergency-numbers',
  );
  const action = useAction();
  return (
    <Page
      title="Estamos para ayudarte"
      description="Asistencia vial, cuando más la necesitas."
      back={false}
    >
      <section className="emergency-hero">
        <span className="emergency-icon">
          <Icon name="help" size={48} />
        </span>
        <h2>¿Un imprevisto en el camino?</h2>
        <p>Busca ayuda y comparte tu ubicación con alguien de confianza.</p>
        <Link className="button danger full" to="/asistencia/nueva">
          Solicitar asistencia
          <Icon name="arrow" size={18} />
        </Link>
      </section>
      <div className="stack">
        <Row
          title="Proveedores cercanos"
          subtitle="Grúas y asistencia en tu ubicación"
          icon="location"
          to="/asistencia/proveedores"
        />
        <Row
          title="Mis contactos SOS"
          subtitle="Llama a tus personas de confianza"
          icon="shield"
          to="/contactos"
        />
        <Row
          title="Historial de asistencia"
          subtitle="Revisa el estado de tus solicitudes"
          icon="document"
          to="/asistencia/historial"
        />
      </div>
      <ErrorNotice error={action.error} />
      <button
        className="button secondary full"
        disabled={action.pending}
        onClick={() =>
          void action.run(async () => {
            const p = await locate();
            await Share.share({
              title: 'Mi ubicación',
              text: `Necesito ayuda. Mi ubicación: https://maps.google.com/?q=${p.lat},${p.lng}`,
            });
          })
        }
      >
        Compartir mi ubicación
      </button>
      <div className="section-heading">
        <h2>Números de emergencia</h2>
      </div>
      <ErrorNotice error={numbers.error} />
      {numbers.isPending ? (
        <Loading />
      ) : (
        numbers.data?.items.map((n) => (
          <a key={n.id} className="card row" href={`tel:${n.phone_number}`}>
            <span className="tile-icon red">
              <Icon name="help" />
            </span>
            <div className="row-text">
              <strong>{n.label}</strong>
              <small>{n.phone_number}</small>
            </div>
            <span>Llamar</span>
          </a>
        ))
      )}
      <p className="notice">
        Si hay peligro inmediato, contacta a los servicios de emergencia. Enviar una solicitud no
        garantiza que haya un proveedor disponible.
      </p>
    </Page>
  );
}
interface Provider {
  id: string;
  name: string;
  address_reference_text: string;
  distance_meters: number;
  availability_status: string;
  contact_actions: { call: { url: string } | null; whatsapp: { url: string } | null };
}
function Providers() {
  const [point, setPoint] = useState<{ lat: number; lng: number }>();
  const action = useAction();
  const result = useApiQuery<{ providers: Provider[]; coverage_found: boolean }>(
    `/assistance-providers/search?lat=${point?.lat}&lng=${point?.lng}`,
    Boolean(point),
  );
  return (
    <Page title="Ayuda cerca de ti" description="Proveedores que cubren tu ubicación.">
      <ErrorNotice error={action.error} />
      <button
        className="button full"
        disabled={action.pending}
        onClick={() => void action.run(async () => setPoint(await locate()))}
      >
        <Icon name="location" />
        Buscar con mi ubicación
      </button>
      <ErrorNotice error={result.error} />
      {point && result.isPending ? (
        <Loading />
      ) : result.data?.providers.length ? (
        <div className="stack">
          {result.data.providers.map((p) => (
            <article className="card" key={p.id}>
              <h2>{p.name}</h2>
              <p>{p.address_reference_text}</p>
              <small>
                {(p.distance_meters / 1000).toFixed(1)} km · {p.availability_status}
              </small>
              <div className="quick-actions">
                {p.contact_actions.call && <a href={p.contact_actions.call.url}>Llamar</a>}
                {p.contact_actions.whatsapp && (
                  <a href={p.contact_actions.whatsapp.url} target="_blank" rel="noreferrer">
                    WhatsApp
                  </a>
                )}
              </div>
            </article>
          ))}
        </div>
      ) : (
        point &&
        result.data && (
          <Empty title="Sin proveedores disponibles">
            Puedes llamar a tus contactos SOS o consultar números de emergencia.
          </Empty>
        )
      )}
      <Link to="/asistencia/nueva" className="button secondary full">
        Crear solicitud de asistencia
      </Link>
    </Page>
  );
}
function RequestForm() {
  const vehicles = useApiQuery<Collection<Vehicle>>('/vehicles');
  const services = useApiQuery<Collection<CatalogItem>>('/catalogs/service-types');
  const [point, setPoint] = useState<{ lat: number; lng: number }>();
  const [id] = useState(() => v7());
  const action = useAction();
  const navigate = useNavigate();
  return (
    <Page title="Solicitar auxilio" description="Cuéntanos qué pasó para encontrar ayuda.">
      <ErrorNotice error={action.error} />
      <ErrorNotice error={services.error} />
      <form
        className="stack"
        onSubmit={(e) => {
          const f = formValues(e);
          void action.run(async () => {
            await api('/assistance-requests', {
              method: 'POST',
              body: {
                id,
                service_type_id: f.service_type_id,
                issue_description: f.issue_description,
                address_reference_text: f.address_reference_text,
                preferred_contact: f.preferred_contact,
                ...(f.vehicle_id ? { vehicle_id: f.vehicle_id } : {}),
                ...(f.contact_phone ? { contact_phone: f.contact_phone } : {}),
                ...(point ? { latitude: point.lat, longitude: point.lng } : {}),
              },
            });
            navigate(`/asistencia/${id}`, { replace: true });
          });
        }}
      >
        <label>
          Vehículo
          <select name="vehicle_id">
            <option value="">No especificar</option>
            {vehicles.data?.items.map((v) => (
              <option key={v.id} value={v.id}>
                {v.brand} {v.model} · {v.plate}
              </option>
            ))}
          </select>
        </label>
        <label>
          ¿Qué servicio necesitas?
          <select name="service_type_id" required>
            <option value="">Seleccionar servicio</option>
            {services.data?.items.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          ¿Qué sucedió?
          <textarea
            name="issue_description"
            required
            maxLength={1000}
            rows={4}
            placeholder="Describe el problema de tu vehículo"
          />
        </label>
        <label>
          Referencia de tu ubicación
          <textarea
            name="address_reference_text"
            required
            minLength={3}
            maxLength={300}
            rows={2}
            placeholder="Carretera, kilómetro y punto de referencia"
          />
        </label>
        <button
          className="button secondary"
          type="button"
          disabled={action.pending}
          onClick={() => void action.run(async () => setPoint(await locate()))}
        >
          <Icon name="location" />
          {point ? 'Ubicación GPS adjunta' : 'Adjuntar ubicación GPS'}
        </button>
        <label>
          Teléfono de contacto
          <input
            name="contact_phone"
            type="tel"
            placeholder="+50588881234"
            pattern="\+[1-9][0-9]{7,14}"
          />
        </label>
        <label>
          Contacto preferido
          <select name="preferred_contact">
            <option value="whatsapp">WhatsApp</option>
            <option value="call">Llamada</option>
            <option value="in_app">Dentro de la app</option>
          </select>
        </label>
        <p className="notice">
          La solicitud necesita conexión. Los costos y condiciones del servicio se acuerdan
          directamente con el proveedor.
        </p>
        <Submit pending={action.pending}>Enviar solicitud de ayuda</Submit>
      </form>
    </Page>
  );
}
function History() {
  const query = useApiQuery<Collection<Assistance>>('/assistance-requests/mine');
  return (
    <Page title="Historial de asistencia">
      <ErrorNotice error={query.error} />
      {query.isPending ? (
        <Loading />
      ) : query.data?.items.length ? (
        <div className="stack">
          {query.data.items.map((r) => (
            <Row
              key={r.id}
              title={r.issue_description}
              subtitle={r.address_reference_text}
              icon="help"
              to={`/asistencia/${r.id}`}
            >
              <Status value={r.status} />
            </Row>
          ))}
        </div>
      ) : (
        !query.error && (
          <Empty title="Sin solicitudes aún" to="/asistencia/nueva" label="Solicitar asistencia">
            Aquí verás el historial de ayuda en carretera.
          </Empty>
        )
      )}
    </Page>
  );
}
function Tracker() {
  const { id } = useParams();
  const query = useApiQuery<Assistance>(`/assistance-requests/mine/${id}`);
  const action = useAction();
  const cache = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  return (
    <Page title="Tu solicitud de auxilio">
      <ErrorNotice error={query.error} />
      <ErrorNotice error={action.error} />
      {query.isPending ? (
        <Loading />
      ) : (
        query.data && (
          <>
            <section className="card tracker">
              <span className="auth-symbol">
                <Icon name="help" size={42} />
              </span>
              <Status value={query.data.status} />
              <h2>{query.data.issue_description}</h2>
              <p>{query.data.address_reference_text}</p>
              {query.data.provider && <p>Proveedor: {query.data.provider.name}</p>}
              <small>
                Última consulta: {new Date(query.dataUpdatedAt).toLocaleTimeString('es-NI')}
              </small>
            </section>
            <button
              className="button full"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              Actualizar estado
            </button>
            {['created', 'dispatched'].includes(query.data.status) && (
              <button className="text-button full danger-text" onClick={() => setConfirm(true)}>
                Cancelar solicitud
              </button>
            )}
          </>
        )
      )}
      {confirm && (
        <Confirm
          title="¿Cancelar el auxilio?"
          close={() => setConfirm(false)}
          pending={action.pending}
          confirm={() =>
            void action.run(async () => {
              await api(`/assistance-requests/mine/${id}/cancel`, { method: 'POST' });
              await cache.invalidateQueries({ queryKey: ['api'] });
              setConfirm(false);
            })
          }
        >
          Se notificará la cancelación de esta solicitud.
        </Confirm>
      )}
    </Page>
  );
}
