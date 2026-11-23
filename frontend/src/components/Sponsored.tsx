import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { CatalogItem, Collection } from '../models';
import { useApiQuery } from '../ui';
interface ServedAd {
  campaign_id: string;
  target: { type: string; slug?: string; name: string; description?: string };
  patrocinado: true;
  expires_at: string;
}
export function Sponsored() {
  const departments = useApiQuery<Collection<CatalogItem>>('/catalogs/departments');
  const [department, setDepartment] = useState(
    () => localStorage.getItem('registro.department.v1') || '',
  );
  const query = useApiQuery<Collection<ServedAd>>(
    `/ads/serve?slot_code=featured_banner&department_id=${department}&limit=3`,
    Boolean(department),
  );
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);
  return (
    <section>
      <div className="section-heading">
        <h2>Destacados en tu zona</h2>
      </div>
      <label>
        Departamento
        <select
          aria-label="Departamento para destacados"
          value={department}
          onChange={(e) => {
            setDepartment(e.target.value);
            localStorage.setItem('registro.department.v1', e.target.value);
          }}
        >
          <option value="">Seleccionar departamento</option>
          {departments.data?.items.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>
      {query.data?.items
        .filter((a) => new Date(a.expires_at).getTime() > clock)
        .map((ad) => (
          <AdCard ad={ad} key={ad.campaign_id} />
        ))}
      {department && query.data && !query.data.items.length && (
        <p className="fine">No hay destacados disponibles en esta zona.</p>
      )}
      {query.error && <p className="fine">Los destacados no están disponibles en este momento.</p>}
    </section>
  );
}
function AdCard({ ad }: { ad: ServedAd }) {
  const node = useRef<HTMLElement>(null);
  const sent = useRef(false);
  useEffect(() => {
    if (!node.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!sent.current && entries.some((e) => e.isIntersecting)) {
          sent.current = true;
          void api('/ads/metrics', {
            method: 'POST',
            body: { campaign_id: ad.campaign_id, event_type: 'impression' },
          }).catch(() => {
            /* Telemetry failure must not interrupt navigation. */
          });
        }
      },
      { threshold: 0.5 },
    );
    observer.observe(node.current);
    return () => observer.disconnect();
  }, [ad.campaign_id]);
  return (
    <article className="card sponsored ad-card" ref={node}>
      <span className="ad-label">Patrocinado</span>
      <h3>{ad.target.name}</h3>
      <p>{ad.target.description}</p>
      <Link
        className="text-button"
        to={
          ad.target.type === 'workshop' && ad.target.slug
            ? `/talleres/${ad.target.slug}`
            : '/asistencia/proveedores'
        }
        onClick={() => {
          void api('/ads/metrics', {
            method: 'POST',
            body: { campaign_id: ad.campaign_id, event_type: 'click' },
          }).catch(() => {});
        }}
      >
        Conocer más →
      </Link>
      <details>
        <summary>¿Por qué veo esto?</summary>
        <p>
          Este negocio contrató un espacio publicitario en el departamento seleccionado. La
          publicidad no cambia sus reseñas ni el orden relativo de los resultados orgánicos.
        </p>
      </details>
    </article>
  );
}
