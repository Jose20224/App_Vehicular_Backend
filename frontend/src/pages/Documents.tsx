import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { v7 } from 'uuid';
import { api, uploadDocument } from '../api';
import {
  date,
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
import type { Collection, DocumentRecord, Policy } from '../models';
export function DocumentForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const action = useAction();
  const cache = useQueryClient();
  const [documentId] = useState(() => v7());
  return (
    <Page title="Nuevo documento" description="Registra su vigencia y luego adjunta el archivo.">
      <ErrorNotice error={action.error} />
      <form
        className="stack"
        onSubmit={(e) => {
          const f = formValues(e);
          void action.run(async () => {
            await api(`/vehicles/${id}/documents`, {
              method: 'POST',
              body: {
                id: documentId,
                title: f.title,
                document_type: f.document_type,
                ...(f.issuer_name ? { issuer_name: f.issuer_name } : {}),
                ...(f.valid_from ? { valid_from: f.valid_from } : {}),
                ...(f.valid_until ? { valid_until: f.valid_until } : {}),
              },
            });
            await cache.invalidateQueries({ queryKey: ['api'] });
            navigate(`/documentos/${documentId}`, { replace: true });
          });
        }}
      >
        <label>
          Tipo
          <select name="document_type">
            <option value="circulacion">Circulación</option>
            <option value="revision">Revisión mecánica</option>
            <option value="licencia">Licencia</option>
            <option value="otro">Otro documento</option>
          </select>
        </label>
        <label>
          Título
          <input name="title" required maxLength={120} placeholder="Circulación de mi vehículo" />
        </label>
        <label>
          Emisor
          <input name="issuer_name" maxLength={120} placeholder="Institución emisora" />
        </label>
        <label>
          Válido desde
          <input type="date" name="valid_from" />
        </label>
        <label>
          Fecha de vencimiento
          <input type="date" name="valid_until" />
        </label>
        <div className="notice">
          <Icon name="bell" />
          <p>Los recordatorios se programan según tus preferencias y la fecha de vencimiento.</p>
        </div>
        <Submit pending={action.pending}>Guardar documento</Submit>
      </form>
    </Page>
  );
}
export function DocumentDetail() {
  const { id } = useParams();
  const query = useApiQuery<DocumentRecord>(`/documents/${id}`);
  const action = useAction();
  const cache = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [editing, setEditing] = useState(false);
  const [download, setDownload] = useState<string>();
  return (
    <Page title={query.data?.title || 'Mi documento'}>
      <ErrorNotice error={query.error} />
      <ErrorNotice error={action.error} />
      {query.isPending ? (
        <Loading />
      ) : (
        query.data && (
          <>
            <div className="document-preview">
              <Icon name="document" size={64} />
              <h2>{query.data.title}</h2>
              <Status value={query.data.status} />
            </div>
            <div className="facts">
              <div>
                <small>Válido desde</small>
                <strong>{date(query.data.valid_from)}</strong>
              </div>
              <div>
                <small>Vencimiento</small>
                <strong>{date(query.data.valid_until)}</strong>
              </div>
            </div>
            <Row
              title="Archivo adjunto"
              subtitle={
                query.data.file_status === 'disponible'
                  ? 'Disponible para descargar'
                  : 'Todavía no has adjuntado un archivo'
              }
            >
              <Status value={query.data.file_status} />
            </Row>
            {query.data.file_status === 'disponible' ? (
              <>
                <button
                  className="button full"
                  disabled={action.pending}
                  onClick={() =>
                    void action.run(async () => {
                      const data = await api<{ download_url: string; simulated?: boolean }>(
                        `/documents/${id}/download-url`,
                        { method: 'POST' },
                      );
                      if (data.simulated)
                        throw new Error('El almacenamiento está en modo simulado.');
                      setDownload(data.download_url);
                    })
                  }
                >
                  Preparar descarga segura
                </button>
                {download && (
                  <a
                    href={download}
                    target="_blank"
                    rel="noreferrer"
                    className="button secondary full"
                  >
                    Abrir documento
                  </a>
                )}
              </>
            ) : (
              <form
                className="card stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  void action.run(async () => {
                    if (!file) throw new Error('Selecciona un archivo.');
                    await uploadDocument(id!, file);
                    await cache.invalidateQueries({ queryKey: ['api'] });
                  });
                }}
              >
                <label>
                  Adjuntar archivo
                  <input
                    type="file"
                    accept="application/pdf,image/jpeg,image/png,image/heic,.heic"
                    required
                    onChange={(e) => setFile(e.target.files?.[0] || null)}
                  />
                </label>
                <small>PDF, JPG, PNG o HEIC · Máximo 10 MB</small>
                <Submit pending={action.pending}>Subir y verificar</Submit>
              </form>
            )}
            <button className="text-button full" onClick={() => setEditing(!editing)}>
              Editar fecha o título
            </button>
            {editing && (
              <form
                className="card stack"
                onSubmit={(e) => {
                  const f = formValues(e);
                  void action.run(async () => {
                    await api(`/documents/${id}`, {
                      method: 'PATCH',
                      body: {
                        title: f.title,
                        ...(f.valid_until ? { valid_until: f.valid_until } : {}),
                      },
                    });
                    await cache.invalidateQueries({ queryKey: ['api'] });
                    setEditing(false);
                  });
                }}
              >
                <label>
                  Título
                  <input name="title" required maxLength={120} defaultValue={query.data.title} />
                </label>
                <label>
                  Vencimiento
                  <input
                    type="date"
                    name="valid_until"
                    defaultValue={query.data.valid_until || ''}
                  />
                </label>
                <Submit pending={action.pending} />
              </form>
            )}
          </>
        )
      )}
    </Page>
  );
}
export function PolicyForm() {
  const { id } = useParams();
  const action = useAction();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const [policyId] = useState(() => v7());
  const [documentId] = useState(() => v7());
  return (
    <Page title="Registrar póliza" description="Protege tus viajes. Mantén tu seguro al día.">
      <ErrorNotice error={action.error} />
      <form
        className="stack"
        onSubmit={(e) => {
          const f = formValues(e);
          void action.run(async () => {
            await api(`/vehicles/${id}/policies`, {
              method: 'POST',
              body: {
                id: policyId,
                document_id: documentId,
                other_insurer_name: f.other_insurer_name,
                policy_number: f.policy_number,
                valid_from: f.valid_from,
                valid_until: f.valid_until,
                currency: f.currency,
                ...(f.claims_phone ? { claims_phone: f.claims_phone } : {}),
                ...(f.premium ? { premium: Number(f.premium) } : {}),
                ...(f.deductible ? { deductible: Number(f.deductible) } : {}),
              },
            });
            await cache.invalidateQueries({ queryKey: ['api'] });
            navigate(`/vehiculos/${id}/polizas/${policyId}`, { replace: true });
          });
        }}
      >
        <label>
          Aseguradora
          <input
            name="other_insurer_name"
            required
            maxLength={120}
            placeholder="Nombre de la aseguradora"
          />
        </label>
        <label>
          Número de póliza
          <input name="policy_number" required maxLength={120} />
        </label>
        <label>
          Inicio de vigencia
          <input type="date" name="valid_from" required />
        </label>
        <label>
          Fin de vigencia
          <input type="date" name="valid_until" required />
        </label>
        <label>
          Moneda
          <select name="currency">
            <option value="USD">USD · Dólares</option>
            <option value="NIO">NIO · Córdobas</option>
          </select>
        </label>
        <div className="form-grid">
          <label>
            Prima
            <input name="premium" type="number" min={0} step="0.01" />
          </label>
          <label>
            Deducible
            <input name="deductible" type="number" min={0} step="0.01" />
          </label>
        </div>
        <label>
          Teléfono de siniestros
          <input
            type="tel"
            name="claims_phone"
            pattern="\+?[0-9]{8,19}"
            placeholder="+50522223333"
          />
        </label>
        <p className="notice">
          Al registrar una nueva póliza, la vigencia anterior se conserva como historial.
        </p>
        <Submit pending={action.pending}>Registrar póliza</Submit>
      </form>
    </Page>
  );
}
export function PolicyDetail() {
  const { id, policyId } = useParams();
  const query = useApiQuery<Collection<Policy>>(`/vehicles/${id}/policies`);
  const policy = query.data?.items.find((p) => p.id === policyId);
  return (
    <Page title="Mi póliza">
      <ErrorNotice error={query.error} />
      {query.isPending ? (
        <Loading />
      ) : policy ? (
        <>
          <section className="hero-card">
            <div>
              <span className="eyebrow light">PROTECCIÓN VEHICULAR</span>
              <h2>{policy.insurer?.name || policy.other_insurer_name}</h2>
              <p>Póliza {policy.policy_number}</p>
            </div>
            <Icon name="shield" size={62} />
          </section>
          <div className="facts">
            <div>
              <small>Desde</small>
              <strong>{date(policy.valid_from)}</strong>
            </div>
            <div>
              <small>Hasta</small>
              <strong>{date(policy.valid_until)}</strong>
            </div>
            <div>
              <small>Prima</small>
              <strong>
                {policy.currency} {policy.premium || '—'}
              </strong>
            </div>
            <div>
              <small>Deducible</small>
              <strong>
                {policy.currency} {policy.deductible || '—'}
              </strong>
            </div>
          </div>
          {policy.claims_phone && (
            <a className="button full" href={`tel:${policy.claims_phone}`}>
              Llamar a siniestros
            </a>
          )}
          {policy.document && (
            <Link className="button secondary full" to={`/documentos/${policy.document.id}`}>
              <Icon name="document" />
              Ver o adjuntar documento
            </Link>
          )}
        </>
      ) : (
        !query.error && <p className="notice">No encontramos esta póliza.</p>
      )}
    </Page>
  );
}
