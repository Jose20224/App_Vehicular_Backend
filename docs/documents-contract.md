# Contrato de documentos y pólizas — B3

## Entidades

- `VehicleDocument`: sync-ready, UUID v7 del cliente, propietario y vehículo obligatorios, tipo `poliza|circulacion|revision|licencia|otro`, título, emisor, vigencias, `file_status`, metadatos S3 privados, timestamps, tombstone y `sync_version` por trigger.
- `InsurancePolicy`: sync-ready, UUID v7, vehículo/propietario, aseguradora de catálogo XOR nombre libre, número cifrado, vigencia, deducible/prima numeric, moneda USD/NIO, teléfono de siniestros cifrado, estado `active|archived`, referencia de renovación, timestamps y `sync_version`.
- `Insurer`: catálogo solo lectura con ETag y versión.

## Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/v1/vehicles/:vehicle_id/documents` | Lista documentos propios activos |
| POST | `/api/v1/vehicles/:vehicle_id/documents` | Registra con `pendiente_subida` |
| GET | `/api/v1/documents/:id` | Consulta documento propio |
| POST | `/api/v1/documents/:id/upload-url` | Genera PUT firmado de 5 minutos |
| POST | `/api/v1/documents/:id/confirm` | Verifica objeto y establece `disponible` |
| POST | `/api/v1/documents/:id/download-url` | GET firmado de 10 minutos |
| GET | `/api/v1/vehicles/:vehicle_id/policies` | Historial de pólizas |
| POST | `/api/v1/vehicles/:vehicle_id/policies` | Crea póliza y renueva/archiva la previa |
| GET | `/api/v1/catalogs/insurers` | Catálogo público versionado con ETag |

### Ejemplo: registrar documento

```json
{
  "id": "018bcfe5-6800-7abc-8def-0123456789ab",
  "document_type": "circulacion",
  "title": "Circulación 2026",
  "issuer_name": "Autoridad emisora",
  "valid_from": "2026-01-01",
  "valid_until": "2026-12-31"
}
```

### Ejemplo: registrar o renovar póliza

```json
{
  "id": "018bcfe5-6800-7abc-8def-0123456789ac",
  "document_id": "018bcfe5-6800-7abc-8def-0123456789ad",
  "other_insurer_name": "Aseguradora no listada",
  "policy_number": "POL-2026-001",
  "valid_from": "2026-01-01",
  "valid_until": "2026-12-31",
  "deductible": 500.00,
  "premium": 450.00,
  "currency": "USD",
  "claims_phone": "+50522223333",
  "title": "Póliza vehicular 2026"
}
```

En lugar de `other_insurer_name`, el cliente puede enviar `insurer_id`; nunca ambos. Los campos `id` y `document_id` son UUID v7 generados por cliente.

Todas las rutas privadas filtran por `user_id`; las rutas bajo vehículo comprueban que el vehículo pertenezca al usuario. Ningún endpoint devuelve keys S3.

## Carga de archivos

1. Registrar documento (UUID v7) con `file_status=pendiente_subida`.
2. Solicitar URL con `content_type` y `size_bytes`; tipos PDF, JPEG, PNG, HEIC; máximo 10 MiB. La key es aleatoria y la genera el backend.
3. Subir directamente a S3 con los headers firmados.
4. Confirmar: backend verifica HEAD, tamaño y MIME declarado, y lee los primeros bytes para detectar firma real PDF/JPEG/PNG/HEIC. Solo después cambia a `disponible`.
5. Si falta confirmación, el registro permanece `pendiente_subida`. El cliente no borra el archivo local hasta recibir la respuesta de confirmación.

La URL GET firmada dura 10 minutos. La URL PUT dura 5 minutos. Mientras una URL PUT siga vigente, la API no emite otra para la misma carga; después de expirar, una nueva URL usa una key distinta para impedir que una URL antigua sobrescriba el objeto confirmado. Producción no permite completar confirmación si el backend no pudo inspeccionar el objeto real.

## Pólizas y vigencia

- `valid_until` debe ser posterior a `valid_from`.
- `deductible` y `premium` son `numeric(12,2)` no negativos.
- `currency` acepta `USD` o `NIO`.
- Debe indicarse `insurer_id` o `other_insurer_name`, exactamente una opción.
- Renovar crea nuevo UUID y archiva la póliza anterior con `previous_policy_id`; la BD permite solo una póliza `active` no eliminada por vehículo.
- Estado calculado: `vigente`, `por_vencer`, `vencido`, usando la fecha local `America/Managua`. `DOCUMENT_EXPIRING_SOON_DAYS` default 30, rango 1–365.
- `policy_number` y `claims_phone` se cifran con AES-256-GCM; AAD v2 incluye `user_id` y `record_id`. La respuesta solo entrega texto claro al dueño autenticado mediante HTTPS; no se registra en logs.

## Errores principales

- `VEHICLE_NOT_FOUND`, `DOCUMENT_NOT_FOUND`: recurso inexistente o ajeno (no se revela existencia de otro dueño).
- `DOCUMENT_FILE_TYPE_NOT_ALLOWED`: formato no admitido o firma real incompatible.
- `DOCUMENT_FILE_TOO_LARGE`: tamaño declarado superior a 10 MiB.
- `DOCUMENT_FILE_SIZE_MISMATCH`: tamaño S3 distinto al declarado.
- `DOCUMENT_UPLOAD_NOT_STARTED`: no existe carga pendiente para confirmar.
- `DOCUMENT_FILE_NOT_AVAILABLE`: descarga solicitada antes de confirmar.
- `DOCUMENT_FILE_CONTENT_UNVERIFIED`: producción no pudo inspeccionar bytes reales.
- `DOCUMENT_UPLOAD_ALREADY_PENDING`: existe una carga pendiente con otros metadatos.
- `STORAGE_OBJECT_NOT_FOUND`: el objeto no está disponible en S3 al confirmar.
- `STORAGE_OBJECT_NOT_VERIFIED`: S3 no permitió verificar la metadata del objeto.
- `DOCUMENT_FILE_INSPECTION_FAILED`: no se pudieron leer los bytes iniciales para verificar la firma.
- `DOCUMENT_VALIDITY_INVALID`, `INSURER_SELECTION_INVALID`, `INSURER_NOT_AVAILABLE`: metadatos inválidos.
- `ID_COLLISION`, `IDEMPOTENCY_PAYLOAD_MISMATCH`, `POLICY_CONFLICT`: UUID duplicado o conflicto de escritura.

Los errores mantienen el envelope global `{code, message, details, request_id}` y mensajes en español.

**Nota de alcance:** `VehicleDocument.vehicle_id` es obligatorio en B3. La posible excepción de licencia personal queda registrada como F-054 para decisión posterior.
