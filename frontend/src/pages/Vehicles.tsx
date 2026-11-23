import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { v7 } from 'uuid';
import { api } from '../api';
import { useSession } from '../session';
import {
  Confirm,
  date,
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
import type { Collection, DocumentRecord, Vehicle } from '../models';
import { Sponsored } from '../components/Sponsored';
export function Dashboard() {
  const { user } = useSession();
  const query = useApiQuery<Collection<Vehicle>>('/vehicles?limit=50');
  return (
    <Page
      title="Tu vehículo, al día"
      description="Un lugar para todo lo que importa."
      back={false}
      action={
        <Link className="icon-button primary" aria-label="Agregar vehículo" to="/vehiculos/nuevo">
          <Icon name="plus" />
        </Link>
      }
    >
      <section className="hero-card">
        <div>
          <span className="eyebrow light">MI ESPACIO VEHICULAR</span>
          <h2>
            Más tranquilidad.
            <br />
            Menos pendientes.
          </h2>
          <p>Cuida lo que te mueve, {user?.display_name.split(' ')[0]}.</p>
        </div>
        <Icon name="car" size={90} />
      </section>
      <div className="quick-actions">
        <Link to="/vehiculos/nuevo">
          <Icon name="car" />
          <span>Agregar vehículo</span>
        </Link>
        <Link to="/talleres">
          <Icon name="search" />
          <span>Buscar taller</span>
        </Link>
        <Link to="/asistencia">
          <Icon name="help" />
          <span>Pedir auxilio</span>
        </Link>
      </div>
      <Sponsored />
      <div className="section-heading">
        <h2>Mis vehículos</h2>
        <span className="count">{query.data?.items.length || 0}</span>
      </div>
      <ErrorNotice error={query.error} />
      {query.isPending ? (
        <Loading />
      ) : query.data?.items.length ? (
        <div className="stack">
          {query.data.items.map((v) => (
            <VehicleCard key={v.id} vehicle={v} />
          ))}
        </div>
      ) : (
        !query.error && (
          <Empty
            title="Aquí comienza tu garaje"
            to="/vehiculos/nuevo"
            label="Registrar mi primer vehículo"
          >
            Agrega tu vehículo y organiza sus documentos y fechas importantes.
          </Empty>
        )
      )}
      {query.data?.has_more && <p className="notice">Se muestran los primeros 50 vehículos.</p>}
      <Link to="/recordatorios" className="card reminder-cta">
        <span className="tile-icon">
          <Icon name="bell" />
        </span>
        <div>
          <strong>Que no se te pase una fecha</strong>
          <p>Configura tus recordatorios de vencimiento.</p>
        </div>
        <Icon name="chevron" />
      </Link>
    </Page>
  );
}
function VehicleCard({ vehicle: v }: { vehicle: Vehicle }) {
  return (
    <Link className="card vehicle-card" to={`/vehiculos/${v.id}`}>
      <div className="vehicle-art">
        {v.photo_url ? (
          <img src={v.photo_url} alt={`${v.brand} ${v.model}`} />
        ) : (
          <Icon name="car" size={64} />
        )}
        <span className="vehicle-year">{v.model_year}</span>
      </div>
      <div className="vehicle-info">
        <div>
          <h3>{v.alias || `${v.brand} ${v.model}`}</h3>
          <p>
            {v.brand} {v.model}
          </p>
          <span className="plate">{v.plate}</span>
        </div>
        <span className="round-arrow">
          <Icon name="arrow" size={20} />
        </span>
      </div>
    </Link>
  );
}
export function VehicleDetail() {
  const { id } = useParams();
  const vehicle = useApiQuery<Vehicle>(`/vehicles/${id}`);
  const docs = useApiQuery<Collection<DocumentRecord>>(`/vehicles/${id}/documents`);
  const action = useAction();
  const [confirm, setConfirm] = useState(false);
  const navigate = useNavigate();
  const cache = useQueryClient();
  return (
    <Page
      title={vehicle.data?.alias || 'Mi vehículo'}
      action={
        <Link className="text-button" to={`/vehiculos/${id}/editar`}>
          Editar
        </Link>
      }
    >
      <ErrorNotice error={vehicle.error} />
      {vehicle.isPending ? (
        <Loading />
      ) : (
        vehicle.data && (
          <>
            <VehicleCard vehicle={vehicle.data} />
            <div className="facts">
              <div>
                <small>Color</small>
                <strong>{vehicle.data.color || 'Sin especificar'}</strong>
              </div>
              <div>
                <small>Kilometraje</small>
                <strong>{vehicle.data.mileage_km?.toLocaleString('es-NI') ?? '—'} km</strong>
              </div>
            </div>
          </>
        )
      )}
      <div className="section-heading">
        <h2>Documentos</h2>
        <Link to={`/vehiculos/${id}/documentos/nuevo`} className="text-button">
          + Agregar
        </Link>
      </div>
      <ErrorNotice error={docs.error} />
      {docs.isPending ? (
        <Loading />
      ) : docs.data?.items.length ? (
        <div className="stack">
          {docs.data.items.map((d) => (
            <Row
              key={d.id}
              title={d.title}
              subtitle={`Vence: ${date(d.valid_until)}`}
              to={`/documentos/${d.id}`}
            >
              <Status value={d.status} />
            </Row>
          ))}
        </div>
      ) : (
        !docs.error && (
          <Empty title="Sin documentos todavía">
            Agrega circulación, revisión, licencia o póliza.
          </Empty>
        )
      )}
      <Link className="button secondary full" to={`/vehiculos/${id}/polizas/nueva`}>
        <Icon name="shield" />
        Registrar o renovar póliza
      </Link>
      <ErrorNotice error={action.error} />
      <button className="text-button danger-text full" onClick={() => setConfirm(true)}>
        Eliminar vehículo
      </button>
      {confirm && (
        <Confirm
          title="¿Eliminar este vehículo?"
          close={() => setConfirm(false)}
          pending={action.pending}
          confirm={() =>
            void action.run(async () => {
              await api(`/vehicles/${id}`, { method: 'DELETE' });
              await cache.invalidateQueries({ queryKey: ['api'] });
              navigate('/inicio', { replace: true });
            })
          }
        >
          Se eliminarán el vehículo y sus documentos asociados. Esta acción no se puede deshacer.
        </Confirm>
      )}
    </Page>
  );
}
export function VehicleForm() {
  const { id } = useParams();
  const query = useApiQuery<Vehicle>(`/vehicles/${id}`, Boolean(id));
  const action = useAction();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const [newId] = useState(() => v7());
  return (
    <Page
      title={id ? 'Editar vehículo' : 'Agregar vehículo'}
      description="Los datos que necesitas, siempre contigo."
    >
      <ErrorNotice error={query.error} />
      <ErrorNotice error={action.error} />
      {id && query.isPending ? (
        <Loading />
      ) : (
        (!id || query.data) && (
          <form
            className="stack"
            key={query.data?.id || 'new'}
            onSubmit={(event) => {
              const f = formValues(event);
              void action.run(async () => {
                const body = {
                  plate: f.plate,
                  brand: f.brand,
                  model: f.model,
                  model_year: Number(f.model_year),
                  vehicle_type: f.vehicle_type,
                  ...(f.nickname ? { nickname: f.nickname } : {}),
                  ...(f.color ? { color: f.color } : {}),
                  ...(f.mileage_km ? { mileage_km: Number(f.mileage_km) } : {}),
                };
                await api(`/vehicles${id ? `/${id}` : ''}`, {
                  method: id ? 'PATCH' : 'POST',
                  body: id ? body : { id: newId, ...body },
                });
                await cache.invalidateQueries({ queryKey: ['api'] });
                navigate(id ? `/vehiculos/${id}` : '/inicio', { replace: true });
              });
            }}
          >
            <div className="form-intro">
              <Icon name="car" size={44} />
              <span>Tu próximo viaje empieza aquí.</span>
            </div>
            <label>
              Placa
              <input
                name="plate"
                required
                minLength={3}
                maxLength={16}
                defaultValue={query.data?.plate}
                placeholder="M123456"
                autoCapitalize="characters"
              />
            </label>
            <div className="form-grid">
              <label>
                Marca
                <input
                  name="brand"
                  required
                  maxLength={80}
                  defaultValue={query.data?.brand}
                  placeholder="Toyota"
                />
              </label>
              <label>
                Modelo
                <input
                  name="model"
                  required
                  maxLength={100}
                  defaultValue={query.data?.model}
                  placeholder="Hilux"
                />
              </label>
            </div>
            <div className="form-grid">
              <label>
                Año
                <input
                  name="model_year"
                  type="number"
                  required
                  min={1950}
                  max={new Date().getFullYear() + 1}
                  defaultValue={query.data?.model_year || new Date().getFullYear()}
                />
              </label>
              <label>
                Tipo
                <select name="vehicle_type" defaultValue={query.data?.vehicle_type || 'automobile'}>
                  <option value="automobile">Automóvil</option>
                  <option value="motorcycle">Motocicleta</option>
                  <option value="pickup">Camioneta</option>
                  <option value="truck">Camión</option>
                  <option value="bus">Bus</option>
                  <option value="other">Otro</option>
                </select>
              </label>
            </div>
            <label>
              Nombre de tu vehículo <span className="fine">(opcional)</span>
              <input
                name="nickname"
                maxLength={80}
                defaultValue={query.data?.alias || ''}
                placeholder="Mi camioneta"
              />
            </label>
            <div className="form-grid">
              <label>
                Color
                <input name="color" maxLength={40} defaultValue={query.data?.color || ''} />
              </label>
              <label>
                Kilometraje
                <input
                  name="mileage_km"
                  type="number"
                  min={0}
                  step={1}
                  defaultValue={query.data?.mileage_km ?? ''}
                />
              </label>
            </div>
            <Submit pending={action.pending}>
              {id ? 'Guardar cambios' : 'Registrar vehículo'}
            </Submit>
          </form>
        )
      )}
    </Page>
  );
}
