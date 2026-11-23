import { v7 } from 'uuid';
import type { Tokens } from './models';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export const API_BASE = (import.meta.env.VITE_API_URL || '/api/v1').replace(/\/$/, '');
// Tokens stay in memory. A reload requires login; never persist credentials in localStorage.
let tokens: Tokens | null = null;
let revision = 0;
let refreshing: Promise<void> | null = null;
let onExpired = () => {};
export function setTokens(value: Tokens | null) {
  tokens = value;
  revision++;
}
export function getTokens() {
  return tokens;
}
export function onSessionExpired(callback: () => void) {
  onExpired = callback;
}
export function deviceId() {
  let id = localStorage.getItem('registro.device.v1');
  if (!id) {
    id = v7();
    localStorage.setItem('registro.device.v1', id);
  }
  return id;
}
async function decode<T>(response: Response): Promise<T> {
  const body = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok)
    throw new ApiError(
      response.status,
      body?.code || 'HTTP_ERROR',
      body?.message || 'No se pudo completar la solicitud.',
      body?.request_id,
      body?.details,
    );
  return body as T;
}
async function refresh() {
  const current = tokens;
  const started = revision;
  if (!current) throw new ApiError(401, 'AUTH_REQUIRED', 'Inicia sesión para continuar.');
  const response = await fetch(`${API_BASE}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: current.refresh_token }),
    signal: AbortSignal.timeout(15000),
  });
  const next = await decode<Tokens>(response);
  if (revision !== started) throw new Error('La sesión cambió.');
  tokens = next;
}
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal; public?: boolean } = {},
  retry = true,
): Promise<T> {
  const headers: Record<string, string> = { 'X-Request-Id': v7() };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (tokens && !options.public) headers.Authorization = `Bearer ${tokens.access_token}`;
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal || AbortSignal.timeout(20000),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiError(
      0,
      'NETWORK_UNAVAILABLE',
      'No podemos conectar con el servidor. Revisa tu conexión e inténtalo otra vez.',
    );
  }
  if (response.status === 401 && tokens && !options.public && retry) {
    try {
      refreshing ??= refresh().finally(() => {
        refreshing = null;
      });
      await refreshing;
    } catch (error) {
      if (error instanceof ApiError && [401, 403, 409].includes(error.status)) {
        setTokens(null);
        onExpired();
      }
      throw error;
    }
    return api<T>(path, options, false);
  }
  try {
    return await decode<T>(response);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'LOCAL_DATA_PURGE_REQUIRED') {
      setTokens(null);
      onExpired();
    }
    throw error;
  }
}
export async function uploadDocument(id: string, file: File) {
  const contentType = file.type || (/\.heic$/i.test(file.name) ? 'image/heic' : '');
  if (!['application/pdf', 'image/jpeg', 'image/png', 'image/heic'].includes(contentType))
    throw new Error('Solo se aceptan PDF, JPG, PNG y HEIC.');
  if (file.size === 0) throw new Error('El archivo está vacío.');
  if (file.size > 10 * 1024 * 1024) throw new Error('El archivo supera 10 MB.');
  const signed = await api<{
    upload_url: string;
    required_headers?: Record<string, string>;
    simulated?: boolean;
  }>(`/documents/${id}/upload-url`, {
    method: 'POST',
    body: { content_type: contentType, size_bytes: file.size, file_name: file.name },
  });
  if (signed.simulated)
    throw new Error(
      'El almacenamiento está en modo simulado. Configura S3 para subir archivos reales.',
    );
  const response = await fetch(signed.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType, ...signed.required_headers },
    body: file,
  });
  if (!response.ok) throw new Error('No se pudo subir el archivo.');
  return api(`/documents/${id}/confirm`, { method: 'POST' });
}
