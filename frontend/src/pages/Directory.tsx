import { lazy, Suspense, useState } from 'react';
import { Link, Route, Routes, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { locate } from '../location';
import type { CatalogItem, Collection, Review, Workshop } from '../models';
import {
  Empty,
  ErrorNotice,
  formValues,
  Icon,
  Loading,
  Page,
  Submit,
  useAction,
  useApiQuery,
  useOnline,
} from '../ui';
const WorkshopMap = lazy(() => import('./WorkshopMap'));
export default function Directory() {
  return (
    <Routes>
      <Route index element={<Search />} />
      <Route path=":slug" element={<Detail />} />
      <Route path=":slug/resena" element={<ReviewForm />} />
    </Routes>
  );
}
function Search() {
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState(false);
  const [open, setOpen] = useState(false);
  const [specialty, setSpecialty] = useState('');
  const [location, setLocation] = useState<{ lat: number; lng: number }>();
  const [map, setMap] = useState(false);
  const action = useAction();
  const online = useOnline();
  const params = new URLSearchParams({
    q: query,
    open_now: String(open),
    limit: '50',
    ...(specialty ? { specialty_id: specialty } : {}),
    ...(location ? { lat: String(location.lat), lng: String(location.lng) } : {}),
  });
  const result = useApiQuery<Collection<Workshop>>(`/workshops/search?${params}`);
  const catalog = useApiQuery<Collection<CatalogItem>>('/catalogs/specialties');
  return (
    <Page title="Encuentra tu taller" description="Confianza para seguir tu camino." back={false}>
      <form
        className="searchbar"
        onSubmit={(e) => {
          const f = formValues(e);
          setQuery(f.q);
        }}
      >
        <Icon name="search" />
        <input
          aria-label="Buscar taller"
          name="q"
          placeholder="Nombre, servicio o especialidad"
          maxLength={100}
        />
        <button className="search-submit" type="submit" aria-label="Buscar">
          <Icon name="arrow" size={18} />
        </button>
      </form>
      <div className="toolbar">
        <button
          className={`chip ${filters ? 'selected' : ''}`}
          onClick={() => setFilters(!filters)}
        >
          Filtros {open || specialty ? '•' : ''}
        </button>
        <button
          className="chip"
          disabled={action.pending}
          onClick={() => void action.run(async () => setLocation(await locate()))}
        >
          <Icon name="location" size={16} />
          {location ? 'Ubicación activa' : 'Cerca de mí'}
        </button>
        <button className="chip" onClick={() => setMap(!map)}>
          {map ? 'Ver lista' : 'Ver mapa'}
        </button>
      </div>
      {filters && (
        <div className="card stack">
          <label>
            Especialidad
            <select value={specialty} onChange={(e) => setSpecialty(e.target.value)}>
              <option value="">Todas</option>
              {catalog.data?.items.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} />
            Abierto ahora
          </label>
          <button
            className="text-button"
            onClick={() => {
              setSpecialty('');
              setOpen(false);
            }}
          >
            Limpiar filtros
          </button>
        </div>
      )}
      <ErrorNotice error={action.error} />
      <ErrorNotice error={result.error} />
      {!online && (
        <p className="notice">El directorio y sus precios necesitan validación en línea.</p>
      )}
      {result.isPending ? (
        <Loading />
      ) : result.data?.items.length ? (
        <>
          <div className="section-heading">
            <h2>{result.data.items.length} talleres encontrados</h2>
            <small>Ordenados por la API</small>
          </div>
          {map ? (
            <Suspense fallback={<Loading />}>
              <WorkshopMap items={result.data.items} />
            </Suspense>
          ) : (
            <div className="stack">
              {result.data.items.map((w) => (
                <WorkshopCard key={w.id} workshop={w} />
              ))}
            </div>
          )}
        </>
      ) : (
        !result.error && (
          <Empty title="No encontramos talleres">Prueba otra búsqueda o amplía tus filtros.</Empty>
        )
      )}
      <p className="fine center">
        Los precios son estimados. Acuerda el servicio directamente con el taller.
      </p>
    </Page>
  );
}
function WorkshopCard({ workshop: w }: { workshop: Workshop }) {
  return (
    <Link
      className={`card workshop-card ${w.sponsored || w.patrocinado ? 'sponsored' : ''}`}
      to={`/talleres/${w.slug}`}
    >
      <div className="workshop-cover">
        {w.photos?.[0]?.url ? (
          <img src={w.photos[0].url} alt={w.name} />
        ) : (
          <Icon name="workshop" size={45} />
        )}
        <span className={`badge ${w.is_open_now ? 'green' : ''}`}>
          {w.is_open_now ? 'Abierto ahora' : 'Ver horarios'}
        </span>
      </div>
      <div className="workshop-body">
        {(w.sponsored || w.patrocinado) && <span className="ad-label">Patrocinado</span>}
        <h3>{w.name}</h3>
        <p>{w.address_reference_text || w.address || 'Consulta la ubicación del taller'}</p>
        <div className="split">
          <span className="rating">
            ★ {w.rating_average ? Number(w.rating_average).toFixed(1) : 'Nuevo'}{' '}
            <small>({w.rating_count || 0})</small>
          </span>
          <span>
            {w.distance_meters != null
              ? `${(w.distance_meters / 1000).toFixed(1)} km`
              : 'Ver detalle'}{' '}
            <Icon name="chevron" size={14} />
          </span>
        </div>
      </div>
    </Link>
  );
}
function Detail() {
  const { slug } = useParams();
  const query = useApiQuery<Workshop>(`/workshops/${slug}`);
  const reviews = useApiQuery<
    Collection<Review & { reviewer_name: string; reply?: { text: string } }>
  >(`/workshops/${query.data?.id}/reviews`, Boolean(query.data?.id));
  const action = useAction();
  const [contacts, setContacts] = useState<{
    phone: string | null;
    whatsapp: string | null;
    email: string | null;
  }>();
  return (
    <Page title={query.data?.name || 'Detalle del taller'}>
      <ErrorNotice error={query.error} />
      <ErrorNotice error={action.error} />
      {query.isPending ? (
        <Loading />
      ) : (
        query.data && (
          <>
            <WorkshopCard workshop={query.data} />
            <section className="card">
              <h2>Sobre el taller</h2>
              <p>{query.data.description || 'El taller aún no ha publicado una descripción.'}</p>
              <p>
                <Icon name="location" size={16} />
                {query.data.address_reference_text || query.data.address}
              </p>
              {query.data.latitude != null && query.data.longitude != null && (
                <a
                  className="button secondary full"
                  target="_blank"
                  rel="noreferrer"
                  href={`https://www.google.com/maps/dir/?api=1&destination=${query.data.latitude},${query.data.longitude}`}
                >
                  Cómo llegar
                </a>
              )}
            </section>
            <button
              className="button full"
              disabled={action.pending}
              onClick={() =>
                void action.run(async () =>
                  setContacts(await api(`/workshops/${slug}/contact-details`)),
                )
              }
            >
              Mostrar contacto del taller
            </button>
            {contacts && (
              <div className="quick-actions">
                {contacts.phone && <a href={`tel:${contacts.phone}`}>Llamar</a>}
                {contacts.whatsapp && (
                  <a
                    href={`https://wa.me/${contacts.whatsapp.replace(/\D/g, '')}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    WhatsApp
                  </a>
                )}
                {contacts.email && <a href={`mailto:${contacts.email}`}>Correo</a>}
              </div>
            )}
            <div className="section-heading">
              <h2>Servicios y precios</h2>
            </div>
            {query.data.service_offerings?.length ? (
              query.data.service_offerings.map((s) => (
                <div className="card split" key={s.id}>
                  <strong>{s.name}</strong>
                  <span>
                    {s.currency} {s.price_min}–{s.price_max} · {s.price_status}
                  </span>
                </div>
              ))
            ) : (
              <p className="muted">
                Consulta los servicios y cotizaciones directamente con el taller.
              </p>
            )}
            <div className="section-heading">
              <h2>Reseñas</h2>
              <Link to={`/talleres/${slug}/resena`} className="text-button">
                Escribir
              </Link>
            </div>
            <ErrorNotice error={reviews.error} />
            {reviews.data?.items.map((r) => (
              <article className="card review" key={r.id}>
                <strong>{r.reviewer_name}</strong>
                <span className="rating" aria-label={`${r.rating} de 5 estrellas`}>
                  {'★'.repeat(r.rating)}
                  {'☆'.repeat(5 - r.rating)}
                </span>
                <p>{r.comment}</p>
                {r.reply && (
                  <blockquote>
                    <strong>Respuesta del taller</strong>
                    <p>{r.reply.text}</p>
                  </blockquote>
                )}
              </article>
            ))}
            {reviews.data && !reviews.data.items.length && (
              <p className="muted">Este taller todavía no tiene reseñas publicadas.</p>
            )}
          </>
        )
      )}
    </Page>
  );
}
function ReviewForm() {
  const { slug } = useParams();
  const query = useApiQuery<Workshop>(`/workshops/${slug}`);
  const action = useAction();
  const cache = useQueryClient();
  const [rating, setRating] = useState(5);
  const [sent, setSent] = useState(false);
  return (
    <Page title="Tu experiencia cuenta">
      <ErrorNotice error={query.error} />
      <ErrorNotice error={action.error} />
      {sent ? (
        <section className="empty">
          <Icon name="check" size={44} />
          <h2>Reseña enviada</h2>
          <p>Tu reseña pasará por moderación antes de publicarse.</p>
          <Link className="button" to={`/talleres/${slug}`}>
            Volver al taller
          </Link>
        </section>
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            const f = formValues(e);
            void action.run(async () => {
              if (!query.data) throw new Error('Espera a que cargue el taller.');
              await api('/reviews', {
                method: 'POST',
                body: { workshop_id: query.data.id, rating, comment: f.comment },
              });
              await cache.invalidateQueries({ queryKey: ['api'] });
              setSent(true);
            });
          }}
        >
          <h2>{query.data?.name}</h2>
          <fieldset>
            <legend>Calificación</legend>
            <div className="stars">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  type="button"
                  aria-label={`${n} estrellas`}
                  aria-pressed={rating === n}
                  key={n}
                  onClick={() => setRating(n)}
                >
                  {n <= rating ? '★' : '☆'}
                </button>
              ))}
            </div>
          </fieldset>
          <label>
            Cuéntanos cómo te fue
            <textarea
              name="comment"
              rows={5}
              maxLength={500}
              placeholder="Comparte tu experiencia con otros conductores."
            />
          </label>
          <p className="fine">No publiques números de teléfono ni datos personales de terceros.</p>
          <Submit pending={action.pending}>Enviar reseña</Submit>
        </form>
      )}
    </Page>
  );
}
