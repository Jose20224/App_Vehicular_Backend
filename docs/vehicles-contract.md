# Contrato B2 — Vehículos y catálogos

**Fase:** B2  
**Versión:** 1.0.0  
**Prefijo:** `/api/v1`  
**Autenticación:** Bearer JWT, salvo catálogos públicos  
**Propietario:** el `user_id` se deriva exclusivamente del JWT; nunca se acepta en DTO.

## 1. Reglas comunes

- `Vehicle.id` lo genera el cliente como UUID v7 antes de persistirlo localmente. La API respeta el ID; nunca lo reemplaza.
- `created_at`, `updated_at`, `deleted_at` y `sync_version` están en la tabla. La secuencia global PostgreSQL y el trigger asignan `sync_version` y `updated_at`; el cliente no los escribe.
- Todas las consultas de vehículos filtran por `user_id` autenticado y `deleted_at IS NULL`. Un ID ajeno se responde como `VEHICLE_NOT_FOUND` para no revelar la existencia del recurso.
- Las escrituras incrementan `sync_version` por trigger, también al marcar el borrado lógico.
- El límite máximo se controla con `MAX_VEHICLES_PER_USER` (por defecto 10; rango de configuración 1–100). Un advisory lock transaccional por usuario evita excederlo con dos altas simultáneas.
- Las placas se normalizan a mayúsculas y se eliminan todos los espacios. Se admiten letras, números y guiones, longitud normalizada de 3 a 16 caracteres. La placa se cifra con AES-256-GCM y se usa HMAC para la unicidad por dueño.
- VIN opcional: se normaliza a mayúsculas sin espacios, se cifra y guarda índice ciego HMAC. No se devuelve metadata criptográfica.
- `brand` y `model` guardan una etiqueta de presentación. `brand_id` y `model_id` son opcionales cuando el valor se selecciona del catálogo; esto permite capturar marcas/modelos no incluidos en el seed inicial. Si se envía `model_id`, debe pertenecer a `brand_id`; cuando se envía un ID de catálogo, la API conserva el nombre canónico del catálogo en el snapshot.
- Tipos admitidos: `motorcycle`, `automobile`, `pickup`, `truck`, `bus`, `other`.
- Año admitido: 1950 hasta el año actual de `America/Managua` + 1. La API y un trigger PostgreSQL comprueban el rango.

## 2. Endpoints

### 2.1 `POST /vehicles`

Crea un vehículo. El ID UUID v7 es obligatorio y lo genera el cliente.

Request:

```json
{
  "id": "018bcfe5-6800-7abc-8def-0123456789ab",
  "plate": "M 123456",
  "brand": "Toyota",
  "model": "Corolla",
  "brand_id": "10000000-0000-4000-8000-000000000010",
  "model_id": "20000000-0000-4000-8000-000000000020",
  "model_year": 2022,
  "vehicle_type": "automobile",
  "color": "Negro",
  "nickname": "Mi vehículo",
  "vin": "3N1AB7AP8KY123456",
  "mileage_km": 45200
}
```

`brand_id` y `model_id` pueden omitirse para captura manual. No se acepta `user_id`, `sync_version`, campos cifrados, estado de archivo ni claves S3.

Response `201 Created` para primera creación; la repetición idéntica devuelve `200 OK`:

```json
{
  "id": "018bcfe5-6800-7abc-8def-0123456789ab",
  "plate": "M123456",
  "brand_id": null,
  "brand": "Toyota",
  "model_id": null,
  "model": "Corolla",
  "model_year": 2022,
  "color": "Negro",
  "vehicle_type": "automobile",
  "alias": "Mi vehículo",
  "vin": "3N1AB7AP8KY123456",
  "mileage_km": 45200,
  "photo_status": "none",
  "photo_url": null,
  "photo_url_expires_in_seconds": null,
  "photo_size_bytes": null,
  "created_at": "2026-11-03T16:00:00.000Z",
  "updated_at": "2026-11-03T16:00:00.000Z",
  "deleted_at": null,
  "sync_version": "1234"
}
```

El valor `sync_version` se serializa como cadena decimal para evitar pérdida de precisión de `BIGINT` en runtimes móviles.

**Idempotencia:** reenviar una creación con el mismo UUID v7 y el mismo contenido devuelve `200 OK`, el registro existente y `idempotent_replay: true`. Si el mismo ID se usa con contenido distinto, devuelve `409 IDEMPOTENCY_PAYLOAD_MISMATCH`. Un ID que ya fue marcado con `deleted_at` nunca se reutiliza y devuelve `409 VEHICLE_ID_RETIRED`. Si el ID pertenece a otro usuario, devuelve `409 ID_COLLISION`. La placa duplicada activa del mismo usuario devuelve `409 PLATE_ALREADY_REGISTERED`.

### 2.2 `GET /vehicles?limit=20&cursor=`

Lista vehículos activos del propietario autenticado. `limit` por defecto 20 y máximo 50. El cursor es el UUID v7 del último vehículo de la página anterior y debe pertenecer al usuario. El orden estable usa `created_at DESC, id DESC` asignados por servidor, no la hora embebida en el UUID cliente.

Response:

```json
{
  "items": [],
  "next_cursor": null,
  "has_more": false,
  "limit": 20
}
```

Errores: `400 VEHICLE_CURSOR_INVALID`.

### 2.3 `GET /vehicles/:id`

Devuelve el vehículo propio. El `photo_url` es una URL firmada temporal generada al consultar y no se persiste en base de datos.

Errores: `404 VEHICLE_NOT_FOUND`, `LOCAL_DATA_PURGE_REQUIRED` cuando el guard de autenticación detecta cuenta/dispositivo revocado.

### 2.4 `PATCH /vehicles/:id`

Permite modificar `plate`, `brand`, `model`, `brand_id`, `model_id`, `model_year`, `vehicle_type`, `color`, `nickname`, `vin` y `mileage_km`. En campos anulables se puede enviar `null` para limpiarlos; no se permite establecer `model_year`, `plate`, `brand`, `model` o `vehicle_type` a `null`.

Si se selecciona `model_id`, debe pertenecer a la marca indicada. Un catálogo desactivado no impide editar campos no relacionados de un vehículo histórico; no puede seleccionarse para una nueva asignación.

Errores: `400 EMPTY_VEHICLE_UPDATE`, `400 VEHICLE_BRAND_INVALID`, `400 VEHICLE_MODEL_BRAND_REQUIRED`, `400 VEHICLE_MODEL_BRAND_MISMATCH`, `400 PLATE_FORMAT_INVALID`, `409 PLATE_ALREADY_REGISTERED`, `404 VEHICLE_NOT_FOUND`.

### 2.5 `DELETE /vehicles/:id`

Marca `vehicles.deleted_at` y, si ya existen las tablas correspondientes, marca también los `vehicle_documents` del mismo dueño/vehículo como borrados lógicos, cancela los `reminders` asociados y marca `insurance_policies` relacionados para borrado lógico. Toda actualización sync-ready pasa por su trigger y crea una nueva versión.

Los objetos de foto se eliminan mediante S3 después de la transacción de base de datos. Las keys privadas se conservan en el tombstone (no se devuelven ni permiten descarga) para que un reconciliador pueda reintentar si S3 falla; nunca se restaura el vehículo. Al reemplazar una foto o descartar una subida pendiente, la limpieza de la key anterior es best-effort y aún no dispone de outbox persistente; esta limitación está registrada en F-044.

Response:

```json
{ "id": "018bcfe5-6800-7abc-8def-0123456789ab", "deleted_at": "2026-11-03T16:00:00.000Z", "status": "deleted" }
```

Errores: `404 VEHICLE_NOT_FOUND`.

### 2.6 `GET /vehicles/:id/summary`

Devuelve el vehículo, conteo de documentos activos y próximo vencimiento futuro (`expires_on`) entre sus documentos. Hasta que la fase de documentos cree `vehicle_documents`, la API devuelve `document_count: 0` y `next_expiration: null`; el endpoint detecta la tabla y comienza a consultar datos reales cuando exista.

Response:

```json
{
  "vehicle": {},
  "document_count": 2,
  "next_expiration": "2027-02-28"
}
```

### 2.7 Foto: subida en dos operaciones

#### `POST /vehicles/:id/photo/upload-url`

Request:

```json
{ "content_type": "image/jpeg", "size_bytes": 245760 }
```

Se aceptan `image/jpeg`, `image/png` y `image/webp`. Tamaño mínimo 1 KiB y máximo `VEHICLE_PHOTO_MAX_BYTES` (por defecto 5 MiB; rango configurable 1 KiB–20 MiB).

La API genera un object key no predecible bajo `users/{user_id}/vehicles/{vehicle_id}/photos/{random_id}`, guarda metadatos de carga pendiente y devuelve una URL PUT firmada. La vigencia se toma de `AWS_S3_PRESIGN_UPLOAD_TTL_SECONDS` (base de arquitectura: 300 s). `S3_CLEANUP_MODE=s3` habilita operaciones S3 reales y URLs AWS firmadas; `mock` simula URLs y confirmaciones solo en desarrollo/pruebas. El móvil sube directamente con los headers indicados. En modo local/mock, la URL es simulada y no representa un endpoint S3 real.

Response:

```json
{
  "vehicle_id": "018bcfe5-6800-7abc-8def-0123456789ab",
  "photo_status": "pending_upload",
  "upload_url": "https://...",
  "expires_in_seconds": 300,
  "required_headers": { "Content-Type": "image/jpeg", "Content-Length": "245760" },
  "simulated": false
}
```

#### `POST /vehicles/:id/photo/confirm`

No recibe object key. La API obtiene la key pendiente de base de datos, consulta `HEAD` en S3 y verifica tamaño y MIME antes de promover la foto a `available`. La copia local no debe borrarse hasta recibir esta confirmación.

Errores: `409 PHOTO_UPLOAD_NOT_PENDING`, `409 PHOTO_OBJECT_NOT_FOUND`, `409 PHOTO_SIZE_MISMATCH`, `409 PHOTO_TYPE_MISMATCH`, `409 PHOTO_UPLOAD_STATE_CHANGED`, `413 PHOTO_TOO_LARGE`, `400 PHOTO_TYPE_NOT_ALLOWED`, `503 PHOTO_UPLOAD_NOT_VERIFIED`, `503 STORAGE_SIGNING_UNAVAILABLE`.

Las consultas `GET /vehicles` y `GET /vehicles/:id` entregan `photo_url` firmada para descargar la fotografía disponible. El cliente debe solicitar de nuevo el recurso al expirar la URL.

## 3. Catálogos versionados

Los catálogos son de solo lectura para el cliente y públicamente descargables.

- `GET /catalogs/vehicle-brands`
- `GET /catalogs/vehicle-models`
- Filtro opcional `brand_id` para modelos.

Toda respuesta `200` incluye el header `ETag` y `catalog_version` como cadena decimal. El cliente envía `If-None-Match`; si la versión no cambió, la API responde `304 Not Modified` sin cuerpo. `catalog_versions` se incrementa con triggers SQL después de insertar, actualizar o eliminar registros de cada catálogo.

Los seeds de desarrollo, pruebas y producción usan el rol `app_migrator`, son idempotentes y no cambian filas si sus valores ya coinciden. El catálogo incluido es inicial y no pretende ser exhaustivo.

## 4. Códigos de error de dominio

| HTTP | Código | Significado |
|---:|---|---|
| 400 | `VALIDATION_ERROR` | DTO inválido. |
| 400 | `PLATE_FORMAT_INVALID` | Placa fuera del formato admitido. |
| 400 | `VEHICLE_BRAND_INVALID` | Marca de catálogo inexistente/inactiva. |
| 400 | `VEHICLE_MODEL_BRAND_REQUIRED` | Se envió modelo de catálogo sin marca. |
| 400 | `VEHICLE_MODEL_BRAND_MISMATCH` | El modelo no pertenece a la marca indicada. |
| 400 | `VEHICLE_CURSOR_INVALID` | Cursor no pertenece a un vehículo activo propio. |
| 404 | `VEHICLE_NOT_FOUND` | Vehículo no encontrado para el dueño autenticado. |
| 409 | `ID_COLLISION` | UUID ya pertenece a otro registro/cuenta. |
| 409 | `IDEMPOTENCY_PAYLOAD_MISMATCH` | El UUID ya existe con contenido diferente. |
| 409 | `VEHICLE_ID_RETIRED` | El UUID corresponde a un vehículo eliminado y no se reutiliza. |
| 409 | `PLATE_ALREADY_REGISTERED` | Placa activa duplicada en la cuenta. |
| 409 | `VEHICLE_LIMIT_REACHED` | Se alcanzó el máximo configurable de vehículos activos. |
| 409 | `PHOTO_UPLOAD_NOT_PENDING` | No existe una subida pendiente. |
| 409 | `PHOTO_OBJECT_NOT_FOUND` | S3 todavía no encuentra el objeto. |
| 413 | `PHOTO_TOO_LARGE` | La foto excede el límite. |
| 503 | `STORAGE_SIGNING_UNAVAILABLE` | No se pudo crear una URL firmada. |

Todos los errores mantienen `{ code, message, details, request_id }` y mensajes en español.

## 5. Notas para B5S y fases dependientes

- `Vehicle` ya es una tabla sync-ready y su `sync_version` lo asigna PostgreSQL. Este B2 no implementa `/sync/push` ni `/sync/pull`; eso sigue perteneciendo a B5S.
- La foto es metadato server-managed. El `object_key` no se entrega al móvil ni debe incluirse en mutaciones sync del cliente. El cliente usa el endpoint de URL firmada.
- La lista inicial de marcas/modelos es semilla de arranque. Debe ampliarse a partir de catálogos revisados, sin hacer que una falta de catálogo impida capturar texto manual.
- La búsqueda de placa por HMAC requiere aplicar el procedimiento de rotación dual/versionada de F-039 antes de rotar la clave de índice ciego.
