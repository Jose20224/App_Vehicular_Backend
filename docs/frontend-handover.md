# Traspaso backend → frontend

Este documento organiza las rutas por pantalla. `GET /docs-json` es la fuente OpenAPI generada por los DTOs/controladores; sincronizar los tipos con `OPENAPI_URL=... npm run openapi:types` antes de una release frontend. Todas las rutas, salvo las marcadas públicas, requieren `Authorization: Bearer <access_token>`.

## App conductor

| Pantalla | Rutas principales |
|---|---|
| Ingreso y cuenta | `POST /auth/otp/request`, `POST /auth/otp/verify`, `POST /auth/refresh`, `POST /auth/logout`, `GET/PATCH /me`, `DELETE /me` |
| Inicio/vehículos | `GET/POST /vehicles`, `GET/PATCH/DELETE /vehicles/:id`, `GET /vehicles/:id/summary`, `POST /vehicles/:id/photo/upload-url`, `POST /vehicles/:id/photo/confirm` |
| Documentos/pólizas | `GET/POST /vehicles/:vehicleId/documents`, `GET /documents/:id`, `POST /documents/:id/upload-url`, `/confirm`, `/download-url`, `GET/POST /vehicles/:vehicleId/policies` |
| Recordatorios | `GET /reminders/schedule`, `GET /notifications`, `PATCH /notifications/:id/read`, `GET/PATCH /me/notification-preferences` |
| Emergencia | `GET /catalogs/emergency-numbers`, `GET/POST/PATCH/DELETE /me/emergency-contacts`, `POST /emergency/share-message` |
| Asistencia vial | `GET /assistance-providers/search`, `POST /assistance-requests`, `GET /assistance-requests`, `POST /assistance-requests/:id/cancel` |
| Talleres | `GET /workshops/search`, `GET /workshops/:slug`, `GET /workshops/:slug/contact-details`, `POST /workshops/:slug/contact-events`, `GET /workshops/:workshopId/reviews`, `POST /reviews` |

## Portal de taller / proveedor

| Pantalla | Rutas principales |
|---|---|
| Perfil y verificación | Taller: `GET /workshops/mine`, `GET/PATCH /workshops/mine/:id`, `POST /workshops/:id/submit-verification`; proveedor: `GET /assistance-providers/mine`, `GET/PATCH /assistance-providers/mine/:id`, `POST /assistance-providers/:id/submit-verification` |
| Contenido de taller | `PUT /workshops/:id/specialties`, `POST /workshops/:id/photos/upload-url`, `POST /workshops/photos/:photoId/confirm`, `POST /service-offerings`, `PATCH/DELETE /service-offerings/:id` |
| Estadísticas/respuestas | `GET /workshops/mine/:id/metrics`, `GET /assistance-providers/mine/:id/metrics`, `POST /workshops/:workshopId/reviews/:reviewId/reply` |
| Publicidad y pago manual | `GET /ads/plans`, `POST /ads/campaigns`, `POST /ads/campaigns/:id/submit`, `POST /ads/campaigns/:id/payment-orders`, `POST /ads/payments/:id/proof-upload-url`, `POST /ads/payments/:id/proofs/:proofId/complete`, `GET /ads/payments/mine`, `GET /ads/campaigns/:id/report` |
| Reclamar precargado | `POST /business-claims/workshops` o `/business-claims/providers` con `{ "business_id": "uuid", "evidence": "..." }` |

## Backoffice

| Pantalla | Rutas principales |
|---|---|
| Dashboard | `GET /admin/dashboard` |
| Cola de negocios | `GET /workshops/:id/...`, `PATCH /workshops/:id/status`, `PATCH /admin/assistance-providers/:id/status` |
| Reclamaciones | `GET /admin/business-claims`, `PATCH /admin/business-claims/:id` con `decision=approve|reject` y motivo para rechazo |
| Reseñas | `GET /admin/reviews/moderation-queue`, `PATCH /admin/reviews/:reviewId/moderation`, `GET /admin/reviews/reports`, `PATCH /admin/reviews/reports/:reportId` |
| Catálogos y emergencia | `PATCH /admin/catalogs/active`, CRUD `/admin/emergency-numbers`, `POST /admin/imports/emergency-numbers-csv` |
| Planes, cupos y pago | `POST /ads/admin/plans`, `/ads/admin/slots`, `GET /ads/admin/payments`, `POST /ads/admin/payments/:id/approve|reject`, `GET /ads/admin/payments/reconciliation`, exportaciones CSV bajo `/ads/admin/exports/` |
| Auditoría | `GET /admin/audit-logs` |

## Respuestas y errores

Todas las respuestas de error siguen la forma:

```json
{
  "code": "RESOURCE_NOT_FOUND",
  "message": "No se encontró el recurso solicitado.",
  "details": {},
  "request_id": "req_..."
}
```

Códigos HTTP comunes: `400 VALIDATION_ERROR`, `401 AUTH_REQUIRED`, `403 FORBIDDEN`, `404 NOT_FOUND`, `409 CONFLICT`, `413 REQUEST_BODY_TOO_LARGE`, `422 UNPROCESSABLE_ENTITY`, `429 RATE_LIMIT_EXCEEDED`, `503 SERVICE_UNAVAILABLE`, `500 INTERNAL_ERROR`. Los códigos de dominio (`DEVICE_PLATFORM_MISMATCH`, `SYNC_CURSOR_EXPIRED`, `ENTITY_NOT_SYNCABLE`, `DUPLICATE_BANK_REFERENCE`, `AD_SLOT_CAPACITY_REACHED`, `BUSINESS_ALREADY_CLAIMED`, etc.) están en `code`; el `request_id` sirve para correlacionar con logs de soporte.

Respuesta ejemplo de búsqueda pública:

```json
{
  "items": [{ "id": "uuid", "slug": "taller-centro", "name": "Taller Centro", "distance_meters": 850, "is_open_now": true, "sponsored": false }],
  "count": 1,
  "cache_ttl_seconds": 60,
  "max_cache_records": 50,
  "fetched_at": "2026-11-17T12:00:00.000Z"
}
```

Respuesta ejemplo de cambios offline:

```json
{
  "channel": "vehicles",
  "changes": { "vehicles": [] },
  "next_cursor": "cursor-opaco-firmado",
  "has_more": false,
  "server_time": "2026-11-17T12:00:00.000Z",
  "overlap_window_versions": "5000"
}
```

## Contrato offline

El cliente no construye cursores. Usa `GET /sync/status`, `GET /sync/bootstrap`, `GET /sync/pull` y `POST /sync/push` con `device_id`, `mutation_id` estable y `base_sync_version` cuando corresponda. Conserva tombstones y respuestas de conflicto; los reintentos reutilizan el mismo `mutation_id`. El dispositivo solo replica identidad, vehículos, documentos, pólizas, preferencias, contactos de emergencia, solicitudes propias y recordatorios. Talleres, proveedores, reseñas, anuncios, pagos, reclamaciones B2B y auditoría son online-only. Consultar `docs/offline-sync-contract.md` para cursores, canales, retención, límites y resolución de conflicto.
