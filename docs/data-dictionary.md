# Diccionario de datos

**Producto:** aplicación móvil de gestión vehicular y asistencia en carretera para Nicaragua
**Versión:** 0.3.0
**Fecha:** 2026-11-09
**Estado:** referencia implementada hasta B5S en backend; la réplica SQLite y la coordinación Flutter quedan para la fase móvil.

Este documento define las entidades lógicas, sus columnas, tipos PostgreSQL, restricciones, índices y relaciones. La implementación física puede ajustar nombres internos, pero no puede debilitar las reglas de propiedad, cifrado, sincronización o integridad aquí descritas sin una decisión registrada en `decisions.md`.

## 1. Convenciones comunes

### 1.1 Tipos y formato

- Identificadores: `uuid`; las entidades sync-ready usan UUID v7 generado por el cliente antes de guardar offline. El servidor valida versión/formato y unicidad.
- Fechas/instantes: `timestamptz` en UTC. Fechas civiles de vencimiento: `date`. Horas de silencio: `time` interpretadas en `America/Managua`.
- Dinero: `numeric(12,2)` para USD/NIO de referencia; tipos nunca `real`, `float` o `double precision` para montos.
- Tasas: `numeric(14,8)` NIO por USD, con fuente y fecha.
- Coordenadas: `geography(Point,4326)` cuando se consulten distancias en metros; `geometry(MultiPolygon,4326)` para límites administrativos si se incorporan polígonos.
- HMAC/ciphertext/hash: `bytea`; no se serializan como texto arbitrario en API.
- Estados/categorías: enums PostgreSQL o `varchar` con `CHECK` explícito. La lista exacta se mantiene versionada.
- JSON variable: `jsonb` únicamente para metadatos no críticos, nunca para sustituir columnas con integridad/índices requeridos.

### 1.2 Plantilla de columnas SYNC-READY

Toda tabla indicada como **SYNC-READY** incorpora como mínimo. Excepción formal de B5S: `users` conserva el ID de identidad generado por el servidor; solo la proyección editable del perfil usa `users.sync_version`, sin permitir alta de identidad desde el móvil:

| Campo | Tipo | Regla |
|---|---|---|
| `id` | `uuid` | PK; UUID v7 generado en el cliente. No se reemplaza por ID del servidor al sincronizar. |
| `user_id` | `uuid` | FK a `users.id`; representa propietario y se indexa. Para contenido de un negocio, identifica al usuario propietario del taller/proveedor. |
| `created_at` | `timestamptz` | Lo fija el servidor en la primera persistencia; no confiar en el reloj del cliente. Puede conservarse aparte `client_created_at` si se necesita trazabilidad offline. |
| `updated_at` | `timestamptz` | Lo fija el servidor en cada escritura. |
| `deleted_at` | `timestamptz NULL` | Borrado lógico. `NULL` significa activo. El cliente no ejecuta borrado físico. |
| `sync_version` | `bigint` | No nulo; lo asigna exclusivamente un trigger `BEFORE INSERT OR UPDATE` mediante `sync_version_seq` global. El cliente no puede enviarlo. |

Cuando una tabla SYNC-READY se referencia mediante FK compuesta para comprobar propietario, declara además `UNIQUE(id,user_id)` aunque `id` ya sea PK.

Índices habituales para cada tabla SYNC-READY:

- B-tree en `(user_id)`.
- B-tree en `(user_id, sync_version)` para filtrado de propietario y lectura incremental.
- B-tree parcial en `(user_id, updated_at)` o `(user_id, deleted_at)` cuando el patrón de consulta lo justifique.
- Índices de FK y restricciones únicas adicionales indicadas en cada entidad.

El trigger global también controla `updated_at`; no se acepta `sync_version` informado por la aplicación. El registro eliminado se entrega a `/sync/pull` como tombstone con `deleted_at` no nulo.

### 1.3 Tablas técnicas con `user_id`

`RefreshToken`, `NotificationLog`, `SyncDevice`, `SyncChannelState`, `SyncBootstrap`, `ProcessedMutation` y `SyncRetentionState` son registros técnicos generados/controlados por el servidor, no contenido editable que se replica al cliente. Aunque algunos contienen `user_id`, no se exponen como entidades de negocio en `/sync/pull`.

### 1.4 Cifrado de campos

Para cada valor cifrado sensible se persiste el conjunto lógico:

- `{campo}_ciphertext bytea NOT NULL`.
- `{campo}_nonce bytea NOT NULL` (12 bytes para AES-GCM).
- `{campo}_tag bytea NOT NULL` (tag GCM de 16 bytes).
- `{campo}_encrypted_dek bytea NOT NULL` (data key cifrada por KMS).
- `{campo}_key_version varchar(100) NOT NULL` (identificador/version de la clave KMS usada).
- Cuando se requiere igualdad/búsqueda exacta: `{campo}_hmac bytea` + `{campo}_hmac_key_version varchar(100)`.

En la implementación puede normalizarse la metadata de cifrado en una estructura reutilizable si se conserva la trazabilidad por valor. El HMAC usa clave de propósito separado de AES. No se indexa ni almacena el texto claro de un campo sensible para facilitar búsquedas.

## 2. Matriz de entidades por dominio

| Dominio | Entidad / tabla | Acceso cliente | Sync |
|---|---|---|---|
| Identidad | `User` / `users` | Perfil propio; identidad administrada por servidor | Sí, solo proyección de perfil (`display_name`, `email`); ID/rol/teléfono/estado server-managed |
| Identidad | `RefreshToken` / `refresh_tokens` | Nunca se expone | No, secreto operativo |
| Identidad | `DeviceToken` / `device_tokens` | Gestión indirecta por endpoint de dispositivo; token nunca se devuelve | No, registro operativo |
| Identidad | `ConsentLog` / `consent_logs` | Evidencia interna; incluida en exportación propia | No, auditoría append-only del servidor |
| Vehículos | `Vehicle` / `vehicles` | CRUD del propietario | Sí |
| Vehículos | `VehicleBrand` / `vehicle_brands` | Solo lectura | No |
| Vehículos | `VehicleModel` / `vehicle_models` | Solo lectura | No |
| Documentos | `Insurer` / `insurers` | Solo lectura | No |
| Documentos | `VehicleDocument` / `vehicle_documents` | CRUD del propietario | Sí |
| Documentos | `InsurancePolicy` / `insurance_policies` | CRUD del propietario | Sí |
| Recordatorios | `Reminder` / `reminders` | Lectura propia; escritura generada por servidor | Sí, pull-only; excluido de push |
| Recordatorios | `NotificationPreference` / `notification_preferences` | CRUD propio | Sí |
| Recordatorios | `NotificationLog` / `notification_logs` | Lectura acotada del historial propio | No, evento técnico del servidor |
| Catálogos | `EmergencyNumber` / `emergency_numbers` | Solo lectura de números verificados | No |
| Catálogos | `EmergencyContact` / `emergency_contacts` | CRUD propio | Sí |
| Catálogos | `ServiceType` / `service_types` | Solo lectura | No |
| Catálogos | `Specialty` / `specialties` | Solo lectura | No |
| Catálogos | `Department` / `departments` | Solo lectura | No |
| Catálogos | `Municipality` / `municipalities` | Solo lectura | No |
| Directorio | `Workshop` / `workshops` | Público: lectura; dueño: CRUD de su ficha | No en B5S; sync de negocio requiere fase/contrato separado |
| Directorio | `WorkshopSpecialty` / `workshop_specialties` | Público: lectura; dueño: edición | No en B5S; sync de negocio requiere fase/contrato separado |
| Directorio | `WorkshopPhoto` / `workshop_photos` | Público: lectura de publicadas; dueño: edición | No en B5S; sync de negocio requiere fase/contrato separado |
| Directorio | `ServiceOffering` / `service_offerings` | Público: lectura; dueño: edición | No en B5S; sync de negocio requiere fase/contrato separado |
| Asistencia | `AssistanceProvider` / `assistance_providers` | Público: lectura; dueño: CRUD de ficha | No en B5S; sync de negocio requiere fase/contrato separado |
| Asistencia | `AssistanceRequest` / `assistance_requests` | CRUD/seguimiento del solicitante; proveedor asignado ve lo necesario | Sí, conductor: push/pull B5S |
| Reseñas | `Review` / `reviews` | Lectura pública; creación de usuario; moderación admin | No en B5S; B8 online-only |
| Reseñas | `ReviewReply` / `review_replies` | Lectura pública; dueño solo inserta respuesta | No en B5S; B8 online-only |
| Reportes | `ReviewReport` / `review_reports` | Usuarios y dueño reportan; admin resuelve | No |
| Publicidad | `AdPlan` / `ad_plans` | Solo lectura para negocios | No |
| Publicidad | `AdSlot` / `ad_slots` | Solo lectura para negocios | No |
| Publicidad | `AdCampaign` / `ad_campaigns` | Dueño anunciante y admin; nunca usuario conductor | No, contratación B2B online |
| Publicidad | `AdMetric` / `ad_metrics` | Lectura agregada al anunciante y admin | No |
| Cobro | `Payment` / `payments` | Dueño anunciante y admin | No, operación B2B con Idempotency-Key |
| Cobro | `Invoice` / `invoices` | Dueño anunciante y admin | No, documento emitido por servidor |
| Cobro | `PaymentProof` / `payment_proofs` | Dueño anunciante y admin | No, comprobante B2B con Idempotency-Key |
| Auditoría | `AuditLog` / `audit_logs` | Solo admin/operación autorizada | No |
| Sync | `SyncDevice` / `sync_devices` | Operación acotada al usuario/dispositivo | No, control de protocolo |
| Sync | `ProcessedMutation` / `processed_mutations` | Nunca expone payload sensible completo | No, idempotencia del servidor |
| Soporte | `IdempotencyRecord` / `idempotency_records` | Nunca se expone directamente | No, replay B2B 24 h |
| Soporte | `ExchangeRate` / `exchange_rates` | Solo lectura de tasa vigente para clientes | No, dato informativo administrado |

## 3. Identidad

### 3.1 `User` — `users`

**Acceso:** usuario autenticado puede leer/editar perfil propio; admin según guard. **Sync:** proyección singleton de perfil; la identidad la crea el servidor y el móvil no puede crearla ni mutar los atributos de autenticación/privilegios.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | PK; generado por servidor al completar alta/verificación OTP. |
| `phone_ciphertext` | `bytea` | Teléfono de cuenta cifrado AES-256-GCM; se descifra solo en memoria para Twilio Verify. |
| `phone_nonce` / `phone_tag` | `bytea` | Nonce/tag GCM. |
| `phone_encrypted_dek` | `bytea` | Data key cifrada por KMS. |
| `phone_key_version` | `varchar(100)` | Versión/identificador KMS. |
| `phone_hmac` | `bytea` | Índice ciego del teléfono normalizado E.164 para lookup/unicidad sin texto claro. |
| `phone_hmac_key_version` | `varchar(100)` | Versión de la clave HMAC independiente. |
| `display_name` | `varchar(120)` | Obligatorio después de completar perfil. |
| `email_ciphertext` | `bytea NULL` | Email cifrado si se recopila; en B1 no se verifica y no sirve para recuperación/autenticación. |
| `email_nonce` / `email_tag` | `bytea NULL` | Nonce/tag GCM. |
| `email_encrypted_dek` | `bytea NULL` | Data key cifrada. |
| `email_key_version` | `varchar(100) NULL` | Versión KMS. |
| `email_hmac` | `bytea NULL` | Índice ciego de email normalizado para igualdad/unicidad. |
| `email_hmac_key_version` | `varchar(100) NULL` | Versión de la clave HMAC independiente. |
| `role` | `user_role` | Uno de `user`, `workshop_owner`, `provider_owner`, `admin`. Una cuenta puede requerir más de una capacidad en el futuro; por ahora el enum es el rol primario acordado. |
| `status` | `user_status` | `pending_verification`, `active`, `suspended`, `deletion_pending`, `deleted`. |
| `phone_verified_at` | `timestamptz NULL` | Momento de verificación confirmado por el proveedor. |
| `last_login_at` | `timestamptz NULL` | Último acceso exitoso. |
| `created_at` | `timestamptz` | UTC, default servidor. |
| `updated_at` | `timestamptz` | UTC. |
| `deleted_at` | `timestamptz NULL` | Soft delete; no borrar físicamente desde endpoint ordinario. |
| `sync_version` | `bigint` | Trigger de perfil instalado en B5S; cambia solo cuando se modifica `display_name`, email cifrado/HMAC, estado o eliminación. |

**Constraints:** `phone_ciphertext` y toda su metadata obligatorios; HMAC obligatorio; `role` y `status` restringidos; nombre no vacío si status active. El teléfono en claro no se persiste.
**Índices:** `UNIQUE(phone_hmac) WHERE deleted_at IS NULL`; `UNIQUE(email_hmac) WHERE email_hmac IS NOT NULL AND deleted_at IS NULL`; `(role,status)`; `(deleted_at)`.
**Reglas sync B5S:** `id` sigue siendo UUID asignado por el servicio de identidad; el cliente usa ese mismo ID al editar `profile`. `/sync/push` admite solo `display_name` y `email`. `phone_*`, `role`, `status`, OTP, sesiones y dispositivos nunca son editables desde sync. El trigger `users_profile_sync_metadata` solo incrementa `sync_version` si cambia la proyección, el estado de cuenta o `deleted_at`; actualizaciones de login/OTP no producen una versión de perfil.
**Relaciones:** 1:N con vehículos, tokens, consentimientos, contactos, recordatorios y solicitudes; 1:0..1 o 1:N con perfil de taller/proveedor según tabla.

### 3.2 `RefreshToken` — `refresh_tokens`

**Acceso:** servidor únicamente. **Sync:** no; es material de autenticación.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | PK generada por servidor. |
| `user_id` | `uuid` | FK `users.id`, obligatorio. |
| `token_hash` | `bytea` | Hash seguro del refresh token; nunca almacenar token en claro. |
| `family_id` | `uuid` | Agrupa rotaciones de una sesión. |
| `device_id` | `uuid NOT NULL` | FK obligatoria a `sync_devices.id`; cada familia de refresh queda ligada a un dispositivo. |
| `expires_at` | `timestamptz` | Expiración absoluta. |
| `revoked_at` | `timestamptz NULL` | Revocación. |
| `replaced_by_id` | `uuid NULL` | FK autorreferente al token que lo reemplaza. |
| `last_used_at` | `timestamptz NULL` | Último uso válido. |
| `created_at` | `timestamptz` | UTC. |
| `user_agent_hash` | `bytea NULL` | Hash/huella reducida; evitar guardar user-agent completo si no hace falta. |
| `ip_hash` | `bytea NULL` | Huella para detección de abuso, no IP en claro por defecto. |

**Constraints:** `token_hash` único; `expires_at > created_at`; un token revocado no vuelve a activo; la rotación revoca el anterior en la misma transacción que crea el nuevo.
**Índices:** `UNIQUE(token_hash)`; `(user_id, expires_at) WHERE revoked_at IS NULL`; `(family_id)`; `(replaced_by_id)`.
**Relaciones:** N:1 `User`; N:1 lógico `SyncDevice` si se enlaza.

### 3.3 `DeviceToken` — `device_tokens`

**Acceso:** endpoint autenticado de registro/rotación de dispositivo; el token FCM nunca se devuelve en respuestas de lectura. **Sync:** no, dato técnico.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | PK; generado por servidor o cliente en la petición de registro. No se usa como entidad offline de negocio. |
| `user_id` | `uuid` | FK `users.id`, obligatorio. |
| `sync_device_id` | `uuid NULL` | FK lógica a `sync_devices.id`. |
| `platform` | `varchar(16)` | `android`, `ios` u otra plataforma explícitamente soportada. |
| `token_ciphertext` | `bytea` | Token FCM cifrado. |
| `token_nonce` / `token_tag` | `bytea` | Nonce/tag GCM. |
| `token_encrypted_dek` | `bytea` | Data key cifrada. |
| `token_key_version` | `varchar(100)` | Versión KMS. |
| `token_aad_version` | `integer` | `1` para ciphertext legado; `2` vincula `user_id` y `device_token_id` en AAD/EncryptionContext. |
| `token_hash` | `bytea` | HMAC/hash dedicado para unicidad y búsqueda exacta. |
| `token_hmac_key_version` | `varchar(100)` | Versión de clave HMAC. |
| `status` | `varchar(16)` | `active`, `invalid`, `revoked`. |
| `created_at` | `timestamptz` | UTC. |
| `updated_at` | `timestamptz` | UTC. |
| `last_seen_at` | `timestamptz NULL` | Última confirmación del dispositivo. |
| `revoked_at` | `timestamptz NULL` | Revocación. |

**Constraints:** `token_hash` único entre tokens activos; `platform` dentro de valores permitidos.
**Índices:** `UNIQUE(token_hash) WHERE status='active'`; `(user_id,status)`; `(sync_device_id)`.
**Relaciones:** N:1 `User`; N:1 opcional `SyncDevice`.

### 3.4 `ConsentLog` — `consent_logs`

**Acceso:** solo el backend crea eventos; la exportación propia incluye la evidencia autorizada. **Sync:** no; append-only del servidor y excluido de `/sync/push` y `/sync/pull`.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | UUID v7 generado por el servidor al registrar la aceptación. |
| `user_id` | `uuid` | FK a `users.id`. |
| `consent_type` | `varchar(40)` | Ej. `privacy_policy`, `terms`, `location`, `marketing`; catálogo controlado. |
| `policy_version` | `varchar(40)` | Versión exacta del texto presentado. |
| `accepted` | `boolean` | Aceptación/retirada según tipo de evento; no sobreescribir un evento anterior. |
| `client_captured_at` | `timestamptz NULL` | Hora informada por el cliente si se recopila; B1 la deja NULL porque no recibe esa señal. |
| `received_at` | `timestamptz` | Hora de recepción del servidor, UTC. |
| `source` | `varchar(24)` | `mobile`, `web_admin`, `migration` u origen permitido. |
| `app_version` | `varchar(40) NULL` | Versión del cliente. |
| `ip_ciphertext`, `ip_nonce`, `ip_tag`, `ip_encrypted_dek`, `ip_key_version` | `bytea` / `varchar(100)` NULL | IP cifrada AES-256-GCM con KMS; solo se descifra para exportación propia. |
| `user_agent_ciphertext`, `user_agent_nonce`, `user_agent_tag`, `user_agent_encrypted_dek`, `user_agent_key_version` | `bytea` / `varchar(100)` NULL | User-Agent cifrado; se anonimiza en eliminación de cuenta. |
| `created_at` | `timestamptz` | Hora de persistencia. |
| `updated_at` | `timestamptz` | Igual a creación; evento inmutable. |
| `deleted_at` | `timestamptz NULL` | No se utiliza para borrar evidencia ordinaria; solo flujo de privacidad validado. |

**Constraints:** evento inmutable; `policy_version` obligatorio; metadata cifrada de IP/User-Agent debe estar completa o totalmente NULL; no permitir que un cliente retroceda la versión del consentimiento vigente. Solo se permite anonimizar las columnas cifradas de IP/User-Agent en el flujo de eliminación de cuenta. Las operaciones sensibles pueden exigir aceptación confirmada en servidor.
**Índices:** `(user_id, received_at DESC)`; `(user_id, consent_type, received_at DESC)`; `(policy_version, consent_type)`.
**Relaciones:** N:1 `User`.

## 4. Vehículos

### 4.1 `Vehicle` — `vehicles`

**Acceso:** propietario. **Sync:** sí, SYNC-READY. El identificador UUID v7 llega del cliente; `sync_version` lo asigna exclusivamente el trigger PostgreSQL.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | PK UUID v7 generado por el cliente. No se sustituye ni reutiliza tras borrado. |
| `user_id` | `uuid` | FK `users.id`; siempre se filtra por el propietario autenticado. |
| `plate_ciphertext`, `plate_nonce`, `plate_tag` | `bytea` | Placa cifrada con AES-256-GCM; metadata obligatoria. |
| `plate_encrypted_dek` | `bytea` | Data key envuelta por KMS. |
| `plate_key_version` | `varchar(100)` | Identificador/versión de la clave maestra usada. |
| `plate_hmac` | `bytea` | Índice ciego HMAC-SHA-256 de placa normalizada; 32 bytes. |
| `plate_hmac_key_version` | `varchar(100)` | Versión de la clave HMAC separada. |
| `brand_id` | `uuid NULL` | FK opcional `vehicle_brands.id`; NULL permite marca escrita manualmente. |
| `brand_label` | `varchar(80)` | Snapshot visible de marca; conserva el dato si el catálogo cambia o se desactiva. |
| `model_id` | `uuid NULL` | FK opcional `vehicle_models.id`; cuando existe debe pertenecer a `brand_id`. |
| `model_label` | `varchar(100)` | Snapshot visible de modelo. |
| `model_year` | `smallint` | Obligatorio; entre 1950 y el año actual de `America/Managua` + 1. |
| `color` | `varchar(40) NULL` | Color opcional. |
| `vehicle_type` | `vehicle_type` enum | `motorcycle`, `automobile`, `pickup`, `truck`, `bus`, `other`. |
| `nickname` | `varchar(80) NULL` | Alias opcional para mostrar al usuario. |
| `vin_ciphertext`, `vin_nonce`, `vin_tag` | `bytea NULL` | VIN opcional cifrado AES-256-GCM; si existe, toda la metadata debe estar presente. |
| `vin_encrypted_dek` | `bytea NULL` | Data key envuelta por KMS. |
| `vin_key_version` | `varchar(100) NULL` | Versión KMS. |
| `vin_hmac` | `bytea NULL` | Índice ciego del VIN, si se proporciona. |
| `vin_hmac_key_version` | `varchar(100) NULL` | Versión de clave HMAC. |
| `mileage_km` | `integer NULL` | Kilometraje no negativo. |
| `photo_status` | `vehicle_photo_status` enum | `none`, `pending_upload`, `available`; estado controlado por API. |
| `photo_object_key` | `varchar(700) NULL` | Key privada del objeto confirmado; nunca se acepta del cliente ni se devuelve. |
| `photo_mime_type` | `varchar(100) NULL` | MIME verificado: JPEG, PNG o WebP. |
| `photo_size_bytes` | `bigint NULL` | Tamaño verificado del objeto actual. |
| `photo_pending_object_key` | `varchar(700) NULL` | Key aleatoria privada para la subida pendiente. |
| `photo_pending_mime_type` | `varchar(100) NULL` | MIME declarado para la subida; validado al confirmar. |
| `photo_pending_size_bytes` | `bigint NULL` | Tamaño declarado; máximo configurable. |
| `created_at`, `updated_at` | `timestamptz` | Base SYNC-READY; trigger actualiza timestamps/versiones. |
| `deleted_at` | `timestamptz NULL` | Borrado lógico. |
| `sync_version` | `bigint` | Secuencia global, asignada por trigger; nunca desde NestJS/cliente. |

**Constraints:** UUID v7; `user_id` obligatorio; placa/VIN nunca en claro; metadata AES-GCM y DEK completa; HMAC de 32 bytes; `model_year >= 1950` y trigger para máximo año actual Managua + 1; kilometraje no negativo; `model_id` pertenece a `brand_id`; foto y metadata coherentes con su estado; una key de objeto no se reutiliza; índice parcial único `(user_id,plate_hmac) WHERE deleted_at IS NULL`.
**Índices:** `UNIQUE(id,user_id)`; `(user_id)`; `(user_id,sync_version)`; `(user_id,created_at DESC,id DESC)`; `(brand_id,model_id)`; `UNIQUE(user_id,plate_hmac) WHERE deleted_at IS NULL`; índices únicos parciales sobre `photo_object_key` y `photo_pending_object_key`.
**Relaciones:** N:1 `User`; N:1 opcional `VehicleBrand` y `VehicleModel`; 1:N `VehicleDocument` y `AssistanceRequest` cuando sus dominios estén instalados.

### 4.2 `VehicleBrand` — `vehicle_brands`

**Acceso:** solo lectura para la app. **Sync:** no, catálogo versionado.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | PK generada en seed/administración. |
| `name` | `varchar(80)` | Nombre visible no vacío. |
| `normalized_name` | `varchar(80)` | Nombre normalizado y único. |
| `is_active` | `boolean` | Solo marcas activas aparecen en catálogo. |
| `sort_order` | `integer` | Orden de presentación. |
| `created_at`, `updated_at` | `timestamptz` | Auditoría de catálogo. |

**Constraints:** `normalized_name` único; nombre no vacío.
**Índices:** `UNIQUE(normalized_name)`; `(is_active,sort_order,normalized_name)`.
**Relaciones:** 1:N `VehicleModel` y 1:N `Vehicle`.

### 4.3 `VehicleModel` — `vehicle_models`

**Acceso:** solo lectura para la app. **Sync:** no, catálogo versionado.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | PK generada en seed/administración. |
| `brand_id` | `uuid` | FK `vehicle_brands.id`. |
| `name` | `varchar(100)` | Nombre visible no vacío. |
| `normalized_name` | `varchar(100)` | Nombre normalizado. |
| `vehicle_category` | `varchar(30) NULL` | Categoría informativa si el catálogo la dispone. |
| `is_active` | `boolean` | Solo modelos activos aparecen en catálogo. |
| `created_at`, `updated_at` | `timestamptz` | Auditoría de catálogo. |

**Constraints:** `UNIQUE(brand_id,normalized_name)`; `UNIQUE(id,brand_id)` para validar asociación compuesta desde vehículos; nombre no vacío.
**Índices:** `(brand_id,is_active,normalized_name)`; `UNIQUE(brand_id,normalized_name)`; `UNIQUE(id,brand_id)`.
**Relaciones:** N:1 `VehicleBrand`; 1:N `Vehicle`.

### 4.4 `CatalogVersion` — `catalog_versions`

**Acceso:** solo lectura para la app. **Sync:** no; metadato de caché HTTP.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `catalog_name` | `varchar(80)` | PK; en B2 `vehicle-brands` o `vehicle-models`. |
| `version` | `bigint` | Contador monotónico incrementado por trigger cuando cambia una fila del catálogo. |
| `updated_at` | `timestamptz` | Último cambio registrado. |

**Constraints:** `version >= 0`; nombre único por PK.
**Índices:** PK sobre `catalog_name`.
**Relaciones:** sin FK; referenciado por `GET /catalogs/{name}` para construir ETag.

## 5. Documentos y pólizas

### 5.1 `Insurer` — `insurers`

**Acceso:** solo lectura para el cliente. **Sync:** no; catálogo versionado.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | PK generado por servidor. |
| `name` | `varchar(120)` | Nombre visible no vacío. |
| `normalized_name` | `varchar(120)` | Único, normalizado. |
| `is_active` | `boolean` | Solo se entregan aseguradoras activas. |
| `sort_order` | `integer` | Orden de presentación. |
| `created_at`, `updated_at` | `timestamptz` | UTC. |

**Índices:** `ux_insurers_normalized_name`; `idx_insurers_active_order`. Trigger actualiza `catalog_versions` con nombre `insurers`; API `GET /catalogs/insurers` devuelve ETag/versión. El catálogo no debe poblarse con nombres no verificados.

### 5.2 `VehicleDocument` — `vehicle_documents`

**Acceso:** propietario. **Sync:** sí, bidireccional; SYNC-READY.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | UUID v7 generado por el cliente. |
| `user_id` | `uuid` | FK a `users`, indexado; siempre filtrado por dueño. |
| `vehicle_id` | `uuid` | Obligatorio en B3; FK compuesta `(vehicle_id,user_id)` a `vehicles`. |
| `document_type` | enum | `poliza`, `circulacion`, `revision`, `licencia`, `otro`. |
| `title` | `varchar(120)` | Obligatorio, no vacío. |
| `issuer_name` | `varchar(120) NULL` | Emisor opcional. |
| `valid_from`, `valid_until` | `date NULL` | Si ambas existen, `valid_until > valid_from`. |
| `file_status` | enum | `pendiente_subida` / `disponible`; server-managed. |
| `file_object_key` | `varchar(700) NULL` | Key S3 final privada; nunca se entrega al cliente. |
| `pending_object_key` | `varchar(700) NULL` | Key temporal aleatoria generada por API. |
| `pending_content_type` | `varchar(100) NULL` | PDF/JPEG/PNG/HEIC declarado para la URL firmada. |
| `pending_size_bytes` | `bigint NULL` | 1 a 10 MiB. |
| `pending_url_issued_at` | `timestamptz NULL` | Hora de emisión de URL; impide reemitir la misma key mientras la URL anterior siga vigente. |
| `file_content_type` | `varchar(100) NULL` | MIME comprobado por firma mágica. |
| `file_size_bytes` | `bigint NULL` | Tamaño real verificado, máximo 10 MiB. |
| `original_file_name` | `varchar(255) NULL` | Metadato saneado, nunca se usa como object key. |
| `insurance_policy_id` | `uuid NULL` | FK única opcional a `insurance_policies`; trigger exige mismo usuario y vehículo. |
| `created_at`, `updated_at`, `deleted_at` | `timestamptz` | UTC; borrado lógico. |
| `sync_version` | `bigint` | Solo trigger global PostgreSQL. |

**Constraints:** UUID v7; FK compuesta garantiza propietario del vehículo; `valid_until > valid_from` si ambas fechas existen; archivo pendiente/disponible debe mantener metadata consistente; MIME permitido y tamaño 1–10 MiB; FK de póliza validada por trigger. **Índices:** `idx_vehicle_documents_user_id`, `idx_vehicle_documents_user_sync_version`, `idx_vehicle_documents_owner_vehicle`, `idx_vehicle_documents_vehicle_expiry`, `ux_vehicle_documents_policy`, `ux_vehicle_documents_file_key`, `ux_vehicle_documents_pending_key`.

**Relaciones:** N:1 `Vehicle` con propietario compuesto; N:1 `User` en FK de base; 1:0..1 `InsurancePolicy`; 1:N `Reminder` generado por el servidor.

### 5.3 `InsurancePolicy` — `insurance_policies`

**Acceso:** propietario. **Sync:** sí, bidireccional; SYNC-READY.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | UUID v7 generado por cliente. |
| `user_id` | `uuid` | FK a `users`, indexado y filtrado por dueño. |
| `vehicle_id` | `uuid` | FK compuesta `(vehicle_id,user_id)` a `vehicles`. |
| `insurer_id` | `uuid NULL` | FK a `insurers`; XOR con nombre libre. |
| `other_insurer_name` | `varchar(120) NULL` | Aseguradora libre cuando no está en catálogo. |
| `policy_number_ciphertext` | `bytea` | Número cifrado AES-256-GCM. |
| `policy_number_nonce`, `policy_number_tag` | `bytea` | Nonce y tag GCM. |
| `policy_number_encrypted_dek` | `bytea` | Data key envuelta por KMS/local dev-test. |
| `policy_number_key_version` | `varchar(100)` | Identificador de clave. |
| `policy_number_aad_version` | `integer` | Versión AAD; nuevas escrituras v2 vinculan dueño/registro. |
| `valid_from`, `valid_until` | `date` | Obligatorios; fin estrictamente posterior al inicio. |
| `deductible`, `premium` | `numeric(12,2) NULL` | No negativos. |
| `currency` | `varchar(3)` | `USD` o `NIO`. |
| `claims_phone_ciphertext`, `claims_phone_nonce`, `claims_phone_tag`, `claims_phone_encrypted_dek`, `claims_phone_key_version`, `claims_phone_aad_version` | `bytea` / `varchar(100)` | Teléfono de siniestros cifrado; campos todos nulos o todos presentes. |
| `status` | enum | `active` / `archived`; no representa el estado de vigencia calculado. |
| `previous_policy_id` | `uuid NULL` | FK autorreferente a póliza anterior; trigger exige mismo usuario/vehículo. |
| `archived_at` | `timestamptz NULL` | Fecha de archivo por renovación. |
| `created_at`, `updated_at`, `deleted_at` | `timestamptz` | UTC; borrado lógico. |
| `sync_version` | `bigint` | Solo trigger global PostgreSQL. |

**Constraints:** UUID v7; exactamente `insurer_id` o `other_insurer_name`; `valid_until > valid_from`; deducible/prima no negativos; moneda USD/NIO; metadata de teléfono cifrado consistente; FK compuesta de vehículo/propietario; trigger valida dueño y vehículo de póliza anterior; una póliza `active` no eliminada por vehículo. **Índices:** `idx_insurance_policies_user_id`, `idx_insurance_policies_user_sync_version`, `idx_insurance_policies_owner_vehicle_status`, `idx_insurance_policies_vehicle_expiry`, `ux_insurance_policies_one_current_per_vehicle`.

**Renovación:** crear un nuevo UUID, archivar la póliza activa anterior, establecer `previous_policy_id` y conservar ambas filas. El estado de vigencia (`vigente`, `por_vencer`, `vencido`) se calcula en `America/Managua`; el umbral `DOCUMENT_EXPIRING_SOON_DAYS` es 30 días por defecto.

**Pendiente de producto:** B3 exige `vehicle_id` para todo `VehicleDocument`, incluso tipo `licencia`. Si la licencia debe pertenecer al perfil del conductor y no a un vehículo, se requiere ampliar el contrato con documentos personales; ver F-054 en `technical-findings.md`.

## 6. Recordatorios y notificaciones

### 6.1 `Reminder` — `reminders`

**Acceso:** propietario, lectura; servidor, escritura. **Sync:** sí, pull-only. Representa programación calculada por el servidor, no una configuración editable desde el móvil.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | UUID v7 generado por servidor para esta proyección. |
| `user_id` | `uuid` | FK `users.id`; propietario. |
| `vehicle_document_id` | `uuid` | FK compuesta con propietario; documento fuente. |
| `title` / `description` | `varchar(120)` / `varchar(500)` | Texto listo para notificación. |
| `reminder_type` | `varchar(24)` | `document_expiry`. |
| `due_at` | `timestamptz` | Fecha/hora local del vencimiento convertida a UTC. |
| `scheduled_at` | `timestamptz` | Hora preferida del recordatorio convertida a UTC. |
| `lead_time_days` | `smallint` | Uno de `30`, `15`, `7`, `1`, `0`. |
| `channel` | `varchar(16)` | `push`; el calendario local es proyección de la API. |
| `status` | `reminder_status` | `scheduled`, `processing`, `sent`, `cancelled`, `failed`. |
| `attempts`, `sent_at`, `cancelled_at` | contador/instantes | Control operativo del worker. |
| `created_at`, `updated_at`, `deleted_at`, `sync_version` | Base SYNC-READY | UTC; `sync_version` por trigger. |

**Reglas:** offsets configurables por usuario; nunca generar instantes pasados. Editar fecha/preferencias o renovar póliza cancela pendientes y regenera en la misma transacción. El cliente no puede crear, posponer, completar ni cancelar recordatorios por `/sync/push`.

### 6.2 `NotificationPreference` — `notification_preferences`

**Acceso:** propietario. **Sync:** sí.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | UUID v7. |
| `user_id` | `uuid` | FK `users.id`. |
| `category` | `varchar(30)` | Por ahora `document_expiry`. |
| `enabled_offsets` | `integer[]` | Subconjunto de `[30,15,7,1,0]`; default todos. |
| `preferred_time` | `varchar(5)` | Hora local `HH:mm`; default `09:00`. |
| `push_enabled`, `local_enabled`, `in_app_enabled` | `boolean` | Canales; defaults true. |
| `timezone` | `varchar(40)` | Fijo `America/Managua`. |
| `created_at`, `updated_at`, `deleted_at`, `sync_version` | Base SYNC-READY | UTC; trigger global. |

**Constraints:** una preferencia activa por usuario/categoría; hora `HH:mm` válida; offsets dentro del conjunto permitido.

### 6.3 `NotificationLog` — `notification_logs`

**Acceso:** lectura resumida al usuario; servidor para escribir. **Sync:** no, evento técnico de entrega.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | PK server. |
| `user_id` | `uuid` | FK `users.id`. |
| `reminder_id` | `uuid NULL` | FK compuesta con propietario. |
| `device_token_id` | `uuid NULL` | FK compuesta con propietario. |
| `channel` | `varchar(16)` | `push`, `in_app`. |
| `provider` | `varchar(32)` | `fcm`, `internal`. |
| `status` | `varchar(20)` | `queued`, `sent`, `failed`, `invalid_token`. |
| `provider_message_id`, `error_code` | `varchar` | Metadatos no sensibles; nunca token ni payload privado. |
| `attempt_count` | `smallint` | Reintentos. |
| `read_at`, `sent_at`, `created_at` | `timestamptz` | Lectura y entrega en UTC. |

**Índices:** `(user_id,created_at DESC)`, `(reminder_id,created_at)`, `(status,created_at)`; unique parcial `(reminder_id,channel)` para idempotencia del log.

## 7. Catálogos y contactos de emergencia

### 7.1 `EmergencyNumber` — `emergency_numbers`

**Acceso:** lectura pública solo de números activos verificados; escritura exclusiva de admin por API. **Sync:** no; catálogo versionado.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | PK del servidor. |
| `label` | `varchar(120)` | Nombre descriptivo. |
| `category` | `varchar(40)` | Policía, bomberos, salud, asistencia vial u otra categoría. |
| `phone_number` | `varchar(20)` | E.164 o número corto nacional. No se publica hasta verificar la fuente. |
| `department_id` | `uuid NULL` | Ámbito territorial opcional. |
| `municipality_id` | `uuid NULL` | FK compuesta con `department_id`; debe pertenecer al departamento indicado. |
| `source_name` | `varchar(180) NULL` | Fuente primaria/oficial; obligatoria si `verified=true`. |
| `source_url` | `varchar(500) NULL` | Referencia a la fuente. |
| `verified` | `boolean` | Default `false`; solo admin puede verificar tras contrastar la fuente. |
| `verified_at` | `timestamptz NULL` | Fecha de verificación; requerida cuando `verified=true`. |
| `verified_by_user_id` | `uuid NULL` | Admin que verificó; FK a `users.id`. |
| `notes` | `varchar(500) NULL` | Notas internas; no se devuelven en catálogo público. |
| `is_active` | `boolean` | Desactivación lógica administrada. |
| `created_at`, `updated_at` | `timestamptz` | Auditoría; cualquier actualización incrementa versión del catálogo. |

**Constraints:** `verified=false` exige `verified_at` y `verified_by_user_id` nulos; `verified=true` requiere `verified_at` y `source_name`. `verified_by_user_id` registra al administrador y puede quedar nulo si la cuenta se elimina físicamente; municipio requiere departamento y debe pertenecerle. Seeds no crean números telefónicos no confirmados.
**Índices:** `(is_active,verified,category)`; `(department_id,municipality_id)`; `(updated_at DESC)`.
**Relaciones:** N:1 opcional `Department`, `Municipality` y `User` (admin verificador).

### 7.2 `EmergencyContact` — `emergency_contacts`

**Acceso:** propietario. **Sync:** sí; UUID v7 del cliente, tombstone para borrado lógico.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | UUID v7 cliente. |
| `user_id` | `uuid` | FK `users.id`; inmutable. |
| `name` | `varchar(120)` | Nombre no vacío. |
| `relationship_label` | `varchar(40) NULL` | Parentesco/relación libre validada. |
| `is_primary` | `boolean` | Máximo un contacto principal activo por usuario. |
| `phone_ciphertext` | `bytea NULL` | Teléfono E.164 cifrado AES-256-GCM; nulo solo después del borrado/anónimo del contacto. |
| `phone_nonce` / `phone_tag` | `bytea NULL` | Nonce de 12 bytes y tag GCM de 16 bytes. |
| `phone_encrypted_dek` | `bytea NULL` | Data key cifrada por KMS. |
| `phone_key_version` | `varchar(100) NULL` | Versión/ID KMS. |
| `phone_aad_version` | `integer NULL` | AAD v2 vinculado a `user_id` e `id`; compatibilidad v1 para datos heredados. |
| `phone_hmac` | `bytea NULL` | HMAC normalizado para igualdad/deduplicación sin texto claro. |
| `phone_hmac_key_version` | `varchar(100) NULL` | Versión de clave HMAC separada. |
| `created_at`, `updated_at` | `timestamptz` | Base SYNC-READY. |
| `deleted_at` | `timestamptz NULL` | Borrado lógico; también purga la información del teléfono. |
| `sync_version` | `bigint` | Trigger global. |

**Constraints:** máximo cinco contactos activos por usuario (servicio y trigger PostgreSQL con bloqueo transaccional); máximo uno principal activo; propietario inmutable; teléfono E.164 cifrado y metadata completa.
**Índices:** `(user_id)`; `(user_id,sync_version)`; `UNIQUE(user_id) WHERE is_primary AND deleted_at IS NULL`.
**Relaciones:** N:1 `User`.

### 7.3 `ServiceType` — `service_types`

**Acceso:** solo lectura. **Sync:** no; catálogo versionado.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | PK del servidor. |
| `code` | `varchar(40)` | Código estable único. |
| `name` | `varchar(100)` | Nombre visible. |
| `description` | `varchar(300) NULL` | Descripción. |
| `is_emergency` | `boolean` | Clasifica el tipo de asistencia. |
| `is_active` | `boolean` | Disponibilidad. |
| `sort_order` | `integer` | Orden de presentación. |
| `created_at`, `updated_at` | `timestamptz` | Auditoría y versionado por trigger. |

**Seeds:** `grua`, `cerrajeria_vial`, `cambio_neumaticos`, `asistencia_medica_basica`, `combustible`, `otro`. No representan números ni servicios de emergencia oficiales.
**Constraints/índices:** `UNIQUE(code)`; `(is_active,sort_order,name)`.
**Relaciones:** 1:N `ServiceOffering`, `AssistanceProvider`, `AssistanceRequest` cuando esos módulos se implementen.

### 7.4 `Specialty` — `specialties`

**Acceso:** solo lectura. **Sync:** no; catálogo versionado.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | PK del servidor. |
| `code` | `varchar(40)` | Código estable único. |
| `name` | `varchar(100)` | Nombre visible. |
| `description` | `varchar(300) NULL` | Descripción. |
| `is_active` | `boolean` | Visible. |
| `sort_order` | `integer` | Orden. |
| `created_at`, `updated_at` | `timestamptz` | Auditoría y versionado por trigger. |

**Índices:** `UNIQUE(code)`; `(is_active,sort_order,name)`.
**Relaciones:** N:M con `Workshop` a través de `WorkshopSpecialty` cuando se implemente el directorio.

### 7.5 `Department` — `departments`

**Acceso:** solo lectura. **Sync:** no; catálogo versionado.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | PK del servidor. |
| `code` | `varchar(20)` | Código interno estable; no se presenta como código oficial INIDE. |
| `name` | `varchar(100)` | Departamento o región autónoma. |
| `administrative_type` | `varchar(24)` | `department` o `autonomous_region`. |
| `is_active` | `boolean` | Visible. |
| `sort_order` | `integer` | Orden de presentación. |
| `created_at`, `updated_at` | `timestamptz` | Auditoría y versionado por trigger. |

**Seeds:** 15 departamentos y 2 regiones autónomas; fuente de división político-administrativa documentada en `catalogs-emergency.md`.
**Índices:** `UNIQUE(code)`; `(is_active,sort_order,name)`.
**Relaciones:** 1:N `Municipality`, `EmergencyNumber`, `Workshop`, `AssistanceProvider`.

### 7.6 `Municipality` — `municipalities`

**Acceso:** solo lectura. **Sync:** no; catálogo versionado.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | PK del servidor. |
| `department_id` | `uuid` | FK `departments.id`. |
| `code` | `varchar(40)` | Código interno estable compuesto por región y nombre; no es código oficial. |
| `name` | `varchar(100)` | Municipio. |
| `is_active` | `boolean` | Visible. |
| `sort_order` | `integer` | Orden dentro del departamento. |
| `created_at`, `updated_at` | `timestamptz` | Auditoría y versionado por trigger. |

**Constraints:** código interno único; FK de emergencia compuesta asegura que la municipalidad pertenece al departamento informado.
**Índices:** `UNIQUE(code)`; `(department_id,is_active,sort_order,name)`.
**Relaciones:** N:1 `Department`; 1:N `EmergencyNumber`, `Workshop`, `AssistanceProvider`.

### 8.1 `Workshop` — `workshops`

**Acceso:** lectura pública de ficha publicada; edición solo del dueño y admin autorizado. **Sync:** sí para el propietario.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | UUID v7 cliente. |
| `user_id` | `uuid` | FK a `users.id`, propietario con rol/capacidad `workshop_owner`. |
| `name` | `varchar(140)` | Nombre público. |
| `slug` | `varchar(180)` | Identificador público único; generado/validado servidor. |
| `description` | `varchar(1200) NULL` | Descripción moderable. |
| `phone_ciphertext` | `bytea` | Teléfono público consentido, cifrado en reposo; la API solo lo descifra tras comprobar que la ficha está publicada. |
| `phone_nonce` / `phone_tag` | `bytea` | Nonce/tag GCM. |
| `phone_encrypted_dek` | `bytea` | Data key cifrada. |
| `phone_key_version` | `varchar(100)` | Versión KMS. |
| `phone_hmac` | `bytea` | HMAC normalizado para igualdad/unicidad. |
| `phone_hmac_key_version` | `varchar(100)` | Versión de clave HMAC. |
| `whatsapp_ciphertext` | `bytea NULL` | WhatsApp público cifrado, puede ser distinto al teléfono. |
| `whatsapp_nonce` / `whatsapp_tag` | `bytea NULL` | Nonce/tag GCM. |
| `whatsapp_encrypted_dek` | `bytea NULL` | Data key cifrada. |
| `whatsapp_key_version` | `varchar(100) NULL` | Versión KMS. |
| `whatsapp_hmac` | `bytea NULL` | HMAC normalizado opcional. |
| `whatsapp_hmac_key_version` | `varchar(100) NULL` | Versión de clave HMAC. |
| `address_reference_text` | `varchar(300)` | Dirección/localización descriptiva; texto de referencia. |
| `department_id` | `uuid` | FK `departments.id`. |
| `municipality_id` | `uuid` | FK `municipalities.id`, debe pertenecer al departamento. |
| `location` | `geography(Point,4326)` | Punto geográfico para cercanía; coordenadas validadas en Nicaragua/área permitida. |
| `status` | `varchar(20)` | `draft`, `pending_review`, `published`, `suspended`. |
| `verified_at` | `timestamptz NULL` | Verificación operativa. |
| `created_at`, `updated_at` | `timestamptz` | Base SYNC-READY. |
| `deleted_at` | `timestamptz NULL` | Borrado lógico. |
| `sync_version` | `bigint` | Trigger global. |

**Constraints:** rol del dueño validado por servicio; municipio y departamento coherentes; metadata de cifrado completa; ficha publicada requiere dirección, ubicación y contacto consentido; `slug` único; `UNIQUE(id,user_id)` para FKs compuestas. La bandera `patrocinado` no se persiste aquí: se deriva de campaña activa aprobada/pagada.
**Índices:** `UNIQUE(slug)`; `UNIQUE(id,user_id)`; `(user_id)`; `(user_id,sync_version)`; `(municipality_id,status)`; `(status,verified_at)`; GiST sobre `location`.
**Relaciones:** N:1 `User`, `Department`, `Municipality`; 1:N `WorkshopSpecialty`, `WorkshopPhoto`, `ServiceOffering`; 1:N `Review` (por target).

### 8.2 `WorkshopSpecialty` — `workshop_specialties`

**Acceso:** lectura pública al consultar taller; modificación solo dueño del taller. **Sync:** sí.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | UUID v7 cliente. |
| `user_id` | `uuid` | Propietario del taller. |
| `workshop_id` | `uuid` | FK compuesta `(workshop_id,user_id)` a dueño del taller. |
| `specialty_id` | `uuid` | FK `specialties.id`. |
| `created_at`, `updated_at` | `timestamptz` | Base SYNC-READY. |
| `deleted_at` | `timestamptz NULL` | Borrado lógico. |
| `sync_version` | `bigint` | Trigger global. |

**Constraints:** una especialidad activa no se repite en el mismo taller; solo propietario del taller puede modificar.
**Índices:** `UNIQUE(id,user_id)`; `(user_id)`; `(user_id,sync_version)`; `UNIQUE(workshop_id,specialty_id) WHERE deleted_at IS NULL`; `(specialty_id,workshop_id)`.
**Relaciones:** N:1 `Workshop`; N:1 `Specialty`.

### 8.3 `WorkshopPhoto` — `workshop_photos`

**Acceso:** lectura pública solo si `status='published'`; escritura del propietario. **Sync:** sí.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | UUID v7 cliente. |
| `user_id` | `uuid` | Propietario del taller. |
| `workshop_id` | `uuid` | FK compuesta con dueño. |
| `object_key` | `varchar(700)` | Key aleatoria S3, única. |
| `alt_text` | `varchar(160) NULL` | Texto accesible. |
| `mime_type` | `varchar(80)` | MIME verificado, allow-list de imágenes. |
| `size_bytes` | `bigint` | Tamaño real. |
| `sha256` | `bytea` | Checksum. |
| `sort_order` | `smallint` | Orden de galería. |
| `status` | `varchar(16)` | `pending`, `published`, `rejected`, `hidden`. |
| `created_at`, `updated_at` | `timestamptz` | Base SYNC-READY. |
| `deleted_at` | `timestamptz NULL` | Borrado lógico. |
| `sync_version` | `bigint` | Trigger global. |

**Constraints:** objeto S3 no repetido; solo tipos permitidos; publicación requiere upload verificado/moderación según política.
**Índices:** `UNIQUE(id,user_id)`; `(user_id)`; `(user_id,sync_version)`; `UNIQUE(object_key)`; `(workshop_id,status,sort_order)`.
**Relaciones:** N:1 `Workshop`.

### 8.4 `ServiceOffering` — `service_offerings`

**Acceso:** lectura pública si publicado; modificación solo por dueño del taller/proveedor. **Sync:** sí.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | UUID v7 cliente. |
| `user_id` | `uuid` | Usuario propietario del negocio que publica la oferta. |
| `workshop_id` | `uuid NULL` | FK compuesta `(workshop_id,user_id)` a `workshops`. |
| `assistance_provider_id` | `uuid NULL` | FK compuesta `(assistance_provider_id,user_id)` a `assistance_providers`. |
| `service_type_id` | `uuid` | FK `service_types.id`. |
| `name` | `varchar(120)` | Nombre del servicio. |
| `description` | `varchar(600) NULL` | Descripción. |
| `min_price_usd` | `numeric(12,2)` | Precio estimado mínimo. |
| `max_price_usd` | `numeric(12,2)` | Precio estimado máximo. |
| `is_active` | `boolean` | Disponible. |
| `publication_status` | `varchar(16)` | `draft`, `published`, `suspended`. |
| `created_at`, `updated_at` | `timestamptz` | Base SYNC-READY. |
| `deleted_at` | `timestamptz NULL` | Borrado lógico. |
| `sync_version` | `bigint` | Trigger global. |

**Constraints críticas:** `CHECK ((workshop_id IS NOT NULL) <> (assistance_provider_id IS NOT NULL))` — exactamente un dueño; `CHECK (min_price_usd > 0 AND max_price_usd >= min_price_usd)`; moneda canónica USD; FK compuesta garantiza que `user_id` coincide con el dueño real; no publicar si negocio está suspendido. El backend añade siempre el texto obligatorio de precio estimado al DTO/respuesta que incluya estos importes.
**Índices:** `UNIQUE(id,user_id)`; `(user_id)`; `(user_id,sync_version)`; `(workshop_id,publication_status)`; `(assistance_provider_id,publication_status)`; `(service_type_id,publication_status)`; `(min_price_usd,max_price_usd)` solo si un filtro por rango se confirma.
**Relaciones:** N:1 exactamente uno entre `Workshop` y `AssistanceProvider`; N:1 `ServiceType`.

## 9. Asistencia en carretera

### 9.1 `AssistanceProvider` — `assistance_providers`

**Acceso:** lectura pública de fichas activas y verificadas; edición del perfil solo por propietario `provider_owner`; activación/suspensión solo por admin. **Sync:** no se replica en el canal offline del conductor. La tabla conserva metadata `sync_version` para una posible sincronización de negocio separada.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | Identificador UUID v7 generado por propietario. |
| `user_id` | `uuid` | FK a usuario propietario `provider_owner`. |
| `name` | `varchar(140)` | Nombre comercial. |
| `provider_type` | `varchar(32)` | Tipo operativo (grúa, neumáticos, cerrajería vial, etc.). |
| `service_type_id` | `uuid` | FK a `service_types.id`; tipo que puede atender. |
| `description` | `varchar(1000) NULL` | Descripción pública moderable. |
| `phone_ciphertext` y metadata | `bytea` / versiones | Teléfono público cifrado AES-256-GCM; AAD v2 ligada a propietario/registro; HMAC ciego para deduplicación. Obligatorio para publicar. |
| `whatsapp_ciphertext` y metadata | `bytea NULL` / versiones | WhatsApp público cifrado de forma independiente; puede ser distinto del teléfono. |
| `address_reference_text` | `varchar(300)` | Referencia textual de la base operativa, obligatoria para publicar. |
| `department_id`, `municipality_id` | `uuid NULL` | FK territorial coherente. |
| `base_location` | `geography(Point,4326)` | Punto de referencia para orden por cercanía. |
| `coverage_area` | `geometry(MultiPolygon,4326)` | Área de servicio GeoJSON normalizada a MultiPolygon; punto en borde incluido con `ST_Covers`; índice GiST. |
| `is_24_hours` | `boolean` | Servicio 24 horas; no garantiza ETA. |
| `availability_status` | `varchar(20)` | `available`, `busy` o `unavailable`; `unavailable` se excluye de búsqueda. |
| `status` | `varchar(20)` | `draft`, `pending_verification`, `active`, `suspended`. Solo activo/verificado es público. |
| `verified_at` | `timestamptz NULL` | Marca de validación administrativa. |
| `created_at`, `updated_at` | `timestamptz` | UTC. |
| `deleted_at` | `timestamptz NULL` | Borrado lógico. |
| `sync_version` | `bigint` | Trigger global; fuera del sync del conductor. |

**Constraints:** metadata de cifrado completa; departamento/municipio coherentes; geometría SRID 4326 válida y no vacía; proveedor activo requiere verificación, polígono, punto base, referencia y teléfono; disponibilidad dentro del enum lógico; `UNIQUE(id,user_id)` para FKs compuestas.
**Índices:** `UNIQUE(id,user_id)`; `(user_id,sync_version)`; `(service_type_id,status)`; `(availability_status,is_24_hours,status)`; GiST `coverage_area`; GiST `base_location` existente.
**Relaciones:** N:1 `User`, `ServiceType`, `Department`, `Municipality`; 1:N `ServiceOffering`, `AssistanceRequest`, `Review`.

### 9.2 `AssistanceRequest` — `assistance_requests`

**Acceso:** solicitante ve y modifica/cancela según estado; proveedor asignado recibe datos mínimos por notificación y enlaces seguros; admin autorizado. **Sync:** sí para el solicitante; nunca se sincronizan asignación/status operativos desde el cliente.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | UUID v7 generado por cliente; permite creación local y posterior sincronización. |
| `user_id` | `uuid` | FK `users.id`; siempre tomado de la sesión, nunca confiado al móvil. |
| `vehicle_id` | `uuid NULL` | FK compuesta con propietario. |
| `service_type_id` | `uuid` | FK a tipo de servicio activo. |
| `assistance_provider_id` | `uuid NULL` | FK física a `assistance_providers.id`; asignación exclusiva del servidor. |
| `issue_description` | `varchar(1000)` | Descripción obligatoria. |
| `address_reference_text` | `varchar(300)` | **NOT NULL**, no vacío. Obligatorio incluso si hay GPS. |
| `location` | `geography(Point,4326) NULL` | Coordenadas GPS opcionales si el usuario no tiene permiso/señal; cuando hay ubicación se consulta cobertura. |
| `department_id`, `municipality_id` | `uuid NULL` | Territorio opcional y coherente. |
| `contact_phone_ciphertext` y metadata | `bytea NULL` / versiones | Teléfono alternativo cifrado si difiere del perfil. |
| `preferred_contact` | `varchar(16)` | `whatsapp`, `call`, `in_app`; preferencia informativa del usuario. |
| `status` | `varchar(24)` | `created`, `sent`, `accepted`, `en_camino`, `completed`, `cancelled`. `pending_envio` solo existe localmente y no se persiste. |
| `requested_at`, `sent_at`, `accepted_at`, `en_camino_at`, `completed_at`, `cancelled_at` | `timestamptz` | Marcas UTC del ciclo operativo. |
| `created_at`, `updated_at` | `timestamptz` | Base SYNC-READY; trigger global para versión. |
| `deleted_at` | `timestamptz NULL` | Borrado lógico; una solicitud recibida se cancela, no se borra físicamente. |
| `sync_version` | `bigint` | Trigger global compartido. |

**Constraints:** referencia textual trim no vacía; GPS dentro de rango; vehículo pertenece al solicitante; proveedor activo/verificado y asignado solo por servidor; transición validada; límite horario y máximo una solicitud activa por vehículo/cuenta; ninguna tarifa/cobro/pago de conductor.
**Índices:** `(user_id)`; `(user_id,sync_version)`; `(user_id,created_at DESC)`; `(status,created_at)`; `(assistance_provider_id,status)`; GiST `location`; índice único parcial de solicitud activa por cuenta/vehículo.
**Relaciones:** N:1 `User`; N:1 opcional `Vehicle`; N:1 `ServiceType`; N:1 opcional `AssistanceProvider`; 1:N `AssistanceActionToken`, `AssistanceRequestEvent`.

### 9.3 `AssistanceActionToken` — `assistance_action_tokens`

Token aleatorio de 256 bits, se almacena exclusivamente SHA-256; tiene una única transición destino, expiración, `used_at`, índice único por hash. El proveedor nunca inicia sesión en la app para esta acción; el enlace bearer confirma la transición en POST y se invalida atómicamente junto con sus enlaces hermanos.

### 9.4 `AssistanceRequestEvent` — `assistance_request_events`

Historial append-only de cambios de estado (`from_status`, `to_status`, `actor_type`, `actor_user_id`, `created_at`). Los eventos no se editan desde la app; índices por solicitud y fecha.

## 10. Reseñas

### 10.1 `Review` — `reviews`

**Acceso:** lectura pública de reseñas publicadas; creación por usuario autenticado; moderación exclusiva de admin. **Sync:** no se replica en B5S; B8 la opera online.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | PK UUID v7 generado por el servidor. |
| `user_id` | `uuid` | Autor autenticado. |
| `workshop_id` | `uuid` | Taller activo reseñado. |
| `vehicle_id` | `uuid NULL` | Vehículo opcional; debe pertenecer al autor. |
| `rating` | `smallint` | Entero 1–5. |
| `comment` | `varchar(500) NULL` | Comentario opcional, máximo 500 caracteres. |
| `status` | `review_status` | `pending`, `published`, `rejected`, `removed`. Toda reseña inicia pending. |
| `content_flagged` | `boolean` | Filtro básico de vocabulario ofensivo; prioriza la cola, no decide la moderación final. |
| `moderation_reason` | `varchar(300) NULL` | Motivo interno/filtro; visible solo en administración. |
| `moderated_by_user_id`, `moderated_at` | `uuid NULL`, `timestamptz NULL` | Admin y fecha que aprobaron, rechazaron o retiraron. |
| `published_at` | `timestamptz NULL` | Fecha de publicación. |
| `created_at`, `updated_at` | `timestamptz` | UTC. |
| `deleted_at` | `timestamptz NULL` | Retiro lógico; no existe borrado físico. |

**Constraints:** `rating BETWEEN 1 AND 5`; comentario de 1–500 caracteres cuando se envía; vehículo pertenece al autor mediante trigger de inserción y validación del servicio; UUID v7; una reseña cada seis meses por usuario/taller usando bloqueo transaccional y reloj PostgreSQL. El contenido del autor es inmutable. Las transiciones de moderación requieren actor admin activo. `removed` requiere `deleted_at`; una reseña retirada conserva su fecha de publicación.  
**Índices:** `(workshop_id,status,published_at DESC)`; `(user_id,workshop_id,created_at DESC)`; cola `(status,content_flagged DESC,created_at)`.  
**Relaciones:** N:1 `User`, `Workshop`; N:1 opcional `Vehicle`; 1:0..1 `ReviewReply`; 1:N `ReviewReport`.

### 10.2 `ReviewReply` — `review_replies`

**Acceso:** lectura pública asociada a reseña publicada; creación solo por el propietario del taller reseñado. **Sync:** no se replica en B5S.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | PK UUID v7 generado por servidor. |
| `review_id` | `uuid` | FK única a `reviews.id`; una respuesta por reseña. |
| `workshop_id` | `uuid` | Taller que contesta. |
| `user_id` | `uuid` | Debe coincidir con el dueño del taller mediante FK compuesta. |
| `reply_text` | `varchar(1200)` | Respuesta no vacía, máximo 1200 caracteres. |
| `created_at` | `timestamptz` | UTC. |

**Constraints:** solo se permite responder a una reseña publicada del mismo taller; FK compuesta `(workshop_id,user_id)`; el propietario no puede editar ni borrar respuestas en B8.  
**Índices:** `UNIQUE(review_id)`; `(workshop_id,created_at DESC)`.  
**Relaciones:** N:1 `Workshop`; 1:1 `Review`.

### 10.3 `ReviewReport` — `review_reports`

**Acceso:** usuarios autenticados reportan una reseña publicada; dueño de taller solo reporta reseñas de su taller; administración consulta/resuelve. **Sync:** no.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | PK UUID v7 generado por servidor. |
| `review_id` | `uuid` | Reseña reportada. |
| `reporter_user_id` | `uuid` | Cuenta que reporta. |
| `reporter_role` | `varchar(16)` | `user` o `workshop_owner`, validado por el backend. |
| `reason` | `varchar(500)` | Motivo obligatorio, 10–500 caracteres. |
| `status` | `review_report_status` | `open`, `resolved`, `dismissed`. |
| `reviewed_by_user_id`, `reviewed_at` | `uuid NULL`, `timestamptz NULL` | Admin y fecha de resolución. |
| `created_at` | `timestamptz` | UTC. |

**Constraints:** un reporte abierto por combinación `review_id,reporter_user_id`; motivo obligatorio; autor no puede reportar su propia reseña.  
**Índices:** `(status,created_at)`; `(review_id,created_at DESC)`; índice único parcial de reportes abiertos.  
**Relaciones:** N:1 `Review`, `User` como reportante y `User` opcional como moderador.

El promedio y total del taller se calculan únicamente con reseñas `published` y no retiradas. Triggers transaccionales actualizan `workshops.rating_average` y `workshops.rating_count`; otro trigger impide que endpoints de taller/publicidad alteren esos agregados directamente. No hay endpoint de propietario/publicidad para editar, ocultar, borrar, moderar u ordenar reseñas.

## 11. Publicidad B2B

### 11.1 `AdPlan` — `ad_plans`

**Acceso:** solo lectura para negocios; administración edita planes. **Sync:** no.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | PK. |
| `code` | `varchar(40)` | Código único. |
| `name` | `varchar(100)` | Nombre comercial. |
| `description` | `varchar(500) NULL` | Descripción B2B. |
| `price_usd` | `numeric(12,2)` | Precio de publicidad para negocio, no usuario conductor. |
| `duration_days` | `smallint` | Duración del plan. |
| `features` | `jsonb` | Características declarativas no críticas. |
| `is_active` | `boolean` | Disponible para contratación. |
| `created_at`, `updated_at` | `timestamptz` | Auditoría. |

**Constraints:** `price_usd >= 0`; `duration_days > 0`; código único. No crear suscripciones ni planes de pago para usuarios conductores.
**Índices:** `UNIQUE(code)`; `(is_active)`.
**Relaciones:** 1:N `AdCampaign`.

### 11.2 `AdSlot` — `ad_slots`

**Acceso:** solo lectura para negocios; administración. **Sync:** no.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | PK. |
| `code` | `varchar(40)` | Ubicación/slot único. |
| `name` | `varchar(100)` | Nombre. |
| `description` | `varchar(300) NULL` | Descripción. |
| `max_active_campaigns` | `integer` | Capacidad máxima. |
| `is_active` | `boolean` | Disponible. |
| `created_at`, `updated_at` | `timestamptz` | Auditoría. |

**Constraints:** `max_active_campaigns > 0`; código único.
**Índices:** `UNIQUE(code)`; `(is_active)`.
**Relaciones:** 1:N `AdCampaign`.

### 11.3 `AdCampaign` — `ad_campaigns`

**Acceso:** dueño anunciante y admin; nunca se presenta como pago al usuario conductor. **Sync:** no; contratación B2B es server-authoritative y usa `Idempotency-Key`.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | PK generada por servidor. |
| `user_id` | `uuid` | Usuario propietario/anunciante. |
| `ad_plan_id` | `uuid` | FK `ad_plans.id`. |
| `ad_slot_id` | `uuid` | FK `ad_slots.id`. |
| `workshop_id` | `uuid NULL` | Taller promocionado, si aplica. |
| `assistance_provider_id` | `uuid NULL` | Proveedor promocionado, si aplica. |
| `campaign_name` | `varchar(120)` | Nombre interno. |
| `starts_at` | `timestamptz` | Inicio UTC. |
| `ends_at` | `timestamptz` | Fin UTC. |
| `status` | `varchar(20)` | `draft`, `awaiting_payment`, `awaiting_review`, `approved`, `active`, `paused`, `completed`, `rejected`. |
| `sponsored` | `boolean` | Debe ser `true` para cualquier contenido publicitario pagado publicado. La API solo lo devuelve true si está aprobado, pagado y vigente. |
| `approved_by_user_id` | `uuid NULL` | Admin que aprobó. |
| `approved_at` | `timestamptz NULL` | Fecha. |
| `created_at`, `updated_at` | `timestamptz` | UTC. |

**Constraints:** exactamente un target (taller XOR proveedor); `ends_at > starts_at`; `sponsored=true` para campañas activas; dueño del target coincide con `user_id`; campaña activa requiere pago aprobado.
**Índices:** `(user_id,status,created_at DESC)`; `(status,starts_at,ends_at)`; `(ad_slot_id,status,starts_at,ends_at)`; `(workshop_id)`; `(assistance_provider_id)`.
**Relaciones:** N:1 `User`, `AdPlan`, `AdSlot`; N:1 exactamente uno `Workshop`/`AssistanceProvider`; 1:N `Payment`, `AdMetric`.

### 11.4 `AdMetric` — `ad_metrics`

**Acceso:** agregado al anunciante dueño y admin. **Sync:** no; agregado del servidor.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | PK server. |
| `ad_campaign_id` | `uuid` | FK `ad_campaigns.id`. |
| `metric_date` | `date` | Día en zona de negocio para agrupación; almacenar definición de corte. |
| `impressions` | `bigint` | Conteo no negativo. |
| `clicks` | `bigint` | Conteo no negativo. |
| `call_clicks` | `bigint` | Conteo de acciones de llamada. |
| `whatsapp_clicks` | `bigint` | Conteo de acciones WhatsApp. |
| `updated_at` | `timestamptz` | Última agregación. |

**Constraints:** `UNIQUE(ad_campaign_id,metric_date)`; métricas no negativas; agregación no incluye PII personal.
**Índices:** `UNIQUE(ad_campaign_id,metric_date)`; `(metric_date,ad_campaign_id)`.
**Relaciones:** N:1 `AdCampaign`.

## 12. Cobros B2B

### 12.1 `Payment` — `payments`

**Acceso:** dueño anunciante y admin. **Sync:** no; cada creación/reintento usa `Idempotency-Key` persistida durante 24 horas.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | PK servidor. |
| `user_id` | `uuid` | Usuario anunciante que inicia el pago. |
| `ad_campaign_id` | `uuid` | FK `ad_campaigns.id`. |
| `amount_usd` | `numeric(12,2)` | Monto canónico B2B. |
| `currency` | `char(3)` | `USD`. |
| `fx_rate_nio_per_usd` | `numeric(14,8) NULL` | Snapshot informativo si se muestra NIO. |
| `amount_nio_reference` | `numeric(14,2) NULL` | Equivalente informativo, no otro cobro. |
| `payment_method` | `varchar(24)` | Inicialmente `bank_transfer`. |
| `status` | `varchar(20)` | `pending`, `proof_received`, `under_review`, `approved`, `rejected`, `cancelled`. |
| `bank_reference_ciphertext` | `bytea NULL` | Referencia bancaria cifrada si se recoge. |
| `bank_reference_nonce` / `bank_reference_tag` | `bytea NULL` | Nonce/tag GCM. |
| `bank_reference_encrypted_dek` | `bytea NULL` | Data key cifrada. |
| `bank_reference_key_version` | `varchar(100) NULL` | Versión KMS. |
| `reviewed_by_user_id` | `uuid NULL` | Admin revisor. |
| `reviewed_at` | `timestamptz NULL` | UTC. |
| `paid_at` | `timestamptz NULL` | Aprobación/confirmación. |
| `created_at`, `updated_at` | `timestamptz` | UTC. |

**Constraints:** solo B2B; `amount_usd >= 0`; `currency='USD'`; transición de estado validada; `user_id` coincide con dueño de campaña; el endpoint de creación requiere `Idempotency-Key`.
**Índices:** `(user_id,created_at DESC)`; `(ad_campaign_id,status)`; `(status,created_at)`; `(reviewed_by_user_id,reviewed_at)`.
**Relaciones:** N:1 `User`, `AdCampaign`; 1:N `PaymentProof`; 1:0..1 `Invoice`.

### 12.2 `Invoice` — `invoices`

**Acceso:** dueño anunciante y administración. **Sync:** no; documento emitido por backend.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | PK servidor. |
| `payment_id` | `uuid` | FK única `payments.id`. |
| `user_id` | `uuid` | Dueño anunciante, duplicado para autorización e índice. |
| `invoice_number` | `varchar(60)` | Número interno único; tratamiento fiscal/tributario se valida localmente. |
| `issued_at` | `timestamptz` | UTC. |
| `amount_usd` | `numeric(12,2)` | Snapshot del monto aprobado. |
| `fx_rate_nio_per_usd` | `numeric(14,8) NULL` | Snapshot informativo. |
| `amount_nio_reference` | `numeric(14,2) NULL` | Equivalente informativo. |
| `document_object_key` | `varchar(700) NULL` | Key S3 privada del archivo generado. |
| `status` | `varchar(16)` | `issued`, `voided`. |
| `created_at` | `timestamptz` | UTC. |

**Constraints:** una factura por pago; monto coincide con el pago aprobado; numeración única; requisitos fiscales y datos obligatorios **validar con abogado/contador local**.
**Índices:** `UNIQUE(payment_id)`; `UNIQUE(invoice_number)`; `(user_id,issued_at DESC)`.
**Relaciones:** 1:1 `Payment`; N:1 `User`.

### 12.3 `PaymentProof` — `payment_proofs`

**Acceso:** dueño del pago y admin revisor. **Sync:** no; carga B2B online con `Idempotency-Key`.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | PK servidor. |
| `payment_id` | `uuid` | FK `payments.id`. |
| `user_id` | `uuid` | Dueño que subió comprobante. |
| `object_key` | `varchar(700)` | Key aleatoria S3 privada. |
| `mime_type` | `varchar(100)` | MIME verificado; allow-list de formatos. |
| `size_bytes` | `bigint` | Tamaño verificado. |
| `sha256` | `bytea` | Checksum. |
| `status` | `varchar(20)` | `uploaded`, `under_review`, `accepted`, `rejected`. |
| `reviewed_by_user_id` | `uuid NULL` | Admin. |
| `reviewed_at` | `timestamptz NULL` | UTC. |
| `created_at` | `timestamptz` | UTC. |

**Constraints:** usuario coincide con dueño de pago; objeto no se reutiliza; un comprobante validado se asocia a pago en estado compatible; `size_bytes > 0`.
**Índices:** `(payment_id,created_at)`; `(user_id,created_at DESC)`; `UNIQUE(object_key)`; `(status,created_at)`.
**Relaciones:** N:1 `Payment`, `User`.

## 13. Auditoría

### 13.1 `AuditLog` — `audit_logs`

**Acceso:** solo admin/operación autorizada; no se expone al usuario normal. **Sync:** no; registro inmutable del servidor.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | PK server. |
| `actor_user_id` | `uuid NULL` | FK `users.id`; null para procesos del sistema. |
| `action` | `varchar(80)` | Acción normalizada. |
| `resource_type` | `varchar(80)` | Tipo de entidad. |
| `resource_id` | `uuid NULL` | ID del recurso afectado. |
| `request_id` | `uuid` | Correlación HTTP/job. |
| `ip_hash` | `bytea NULL` | Huella de origen; evitar IP en claro salvo necesidad aprobada. |
| `metadata` | `jsonb` | Campos mínimos, allow-list; nunca token, OTP, URL firmada ni texto claro sensible. |
| `created_at` | `timestamptz` | UTC, append-only. |

**Constraints:** no update ordinario; metadatos saneados; acción/recurso/request id obligatorios.
**Índices:** `(actor_user_id,created_at DESC)`; `(resource_type,resource_id,created_at DESC)`; `UNIQUE(request_id,action,resource_type,resource_id)` solo cuando el evento necesite deduplicación.
**Relaciones:** N:1 opcional `User` como actor.

## 14. Sincronización

### 14.1 `SyncDevice` — `sync_devices`

**Acceso:** solo endpoint de sincronización/dispositivo autenticado; un usuario solo administra sus propios dispositivos. **Sync:** no; control del protocolo, no contenido a replicar.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | UUID v7 generado por cliente/dispositivo al registrarse. |
| `user_id` | `uuid` | FK `users.id`; siempre filtrar por dueño. |
| `platform` | `varchar(16)` | `android`, `ios`. |
| `device_label` | `varchar(100) NULL` | Nombre legible no sensible. |
| `client_version` | `varchar(40) NULL` | Versión app. |
| `last_seen_at` | `timestamptz NULL` | Último contacto. |
| `last_cursor` | `bigint NULL` | Cursor aceptado más reciente, si el servidor lo conserva. |
| `revoked_at` | `timestamptz NULL` | Revocación del dispositivo. |
| `created_at`, `updated_at` | `timestamptz` | UTC. |
| `deleted_at` | `timestamptz NULL` | Soft delete de registro técnico. |

**Constraints:** `UNIQUE(user_id,id)`; dispositivo revocado no puede sincronizar; cursor no negativo.
**Índices:** `(user_id)`; `(user_id,last_seen_at DESC)`; `(revoked_at)`.
**Relaciones:** N:1 `User`; 1:N `DeviceToken`, `ProcessedMutation`.

### 14.2 `SyncChannelState` — `sync_channel_states`

**Acceso:** solo servidor. **Sync:** no; mantiene el cursor independiente de cada canal y dispositivo.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `user_id` | `uuid` | Propietario; debe coincidir con el dispositivo registrado. |
| `device_id` | `uuid` | FK compuesta a `sync_devices(user_id,id)`. |
| `channel` | `varchar(40)` | `all`, `profile`, `vehicles`, `documents`, `policies`, `notification_preferences`, `emergency_contacts`, `assistance_requests` o `reminders`. |
| `acknowledged_cursor` | `bigint` | Watermark reconocido por canal; nunca decrece. |
| `last_pulled_at` | `timestamptz NULL` | Última confirmación del canal. |
| `created_at`, `updated_at` | `timestamptz` | UTC. |

**Constraints:** PK `(device_id,channel)`; FK compuesta garantiza que el dispositivo pertenece al usuario; cursor no negativo; canal restringido por `CHECK`. Cada canal avanza sin modificar los cursores de los demás.

### 14.3 `SyncBootstrap` — `sync_bootstraps`

**Acceso:** solo servidor. **Sync:** no; sesión temporal de snapshot paginado.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | ID aleatorio generado por servidor. |
| `user_id`, `device_id` | `uuid` | Propietario y dispositivo asociado mediante FK compuesta. |
| `snapshot_sync_version` | `bigint` | Watermark fijo de todas las páginas de la sesión. |
| `expires_at` | `timestamptz` | Expiración 24 horas después de la creación. |
| `created_at` | `timestamptz` | UTC. |

Los tokens de página contienen posición/entidad y están firmados; la fila solo existe durante la paginación y se elimina al completar el bootstrap o al expirar una sesión que se sustituye.

### 14.4 `ProcessedMutation` — `processed_mutations`

**Acceso:** servidor únicamente; el resultado original se almacena cifrado. **Sync:** no; idempotencia de `/sync/push`.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `user_id` | `uuid` | FK a `users.id`. |
| `mutation_id` | `uuid` | Clave idempotente aportada por el cliente. |
| `device_id` | `uuid` | FK compuesta a dispositivo del mismo dueño. |
| `entity`, `entity_id` | `varchar(40)`, `uuid` | Tipo e ID de recurso afectado. |
| `payload_hash` | `bytea` | SHA-256 del JSON canónico; detectar reuso de ID con contenido distinto. |
| `result_ciphertext`, `result_nonce`, `result_tag` | `bytea` | Respuesta idempotente cifrada AES-GCM. |
| `result_encrypted_dek` | `bytea` | Data key cifrada por KMS. |
| `result_key_version` | `varchar(100)` | Versión/ID de clave KMS. |
| `processed_at` | `timestamptz` | Momento UTC de confirmación. |

**Constraints:** PK `(user_id,mutation_id)`; una repetición con mismo hash devuelve el resultado cifrado original; mismo ID con otro hash se rechaza como `MUTATION_ID_REUSE`. Retención mínima 180 días; B5S no instala una purga automática.

### 14.5 `SyncRetentionState` — `sync_retention_state`

**Acceso:** lectura del runtime; mantenimiento privilegiado fuera de los endpoints de usuario. **Sync:** no.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `smallint` | Único valor permitido: `1`. |
| `minimum_valid_cursor` | `bigint` | Cursor inferior aceptado; si un cursor anterior se presenta, la API exige bootstrap. |
| `updated_at` | `timestamptz` | Momento de mantenimiento. |

La migración inicia el cursor mínimo en `0`. B5S no agrega un job automático que avance este valor o purgue tombstones. La vigencia de 90 días corresponde a los cursores firmados y a la inactividad del canal; los tombstones permanecen físicamente hasta que una política posterior avance el mínimo y ejecute la limpieza aprobada.

## 15. Tablas técnicas de soporte

Estas dos entidades se agregan porque son necesarias para cumplir requisitos explícitos de conversión informativa USD/NIO e idempotencia B2B de 24 horas. No sustituyen entidades de negocio.

### 15.1 `IdempotencyRecord` — `idempotency_records`

**Acceso:** servidor únicamente. **Sync:** no.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | PK servidor. |
| `actor_scope` | `varchar(160)` | Scope estable, por ejemplo usuario + grupo de endpoint; no contiene secreto. |
| `idempotency_key_hash` | `bytea` | Hash de `Idempotency-Key` para no almacenar necesariamente el valor original. |
| `request_hash` | `bytea` | Hash de método, ruta y payload canónico. |
| `response_status` | `smallint` | Status HTTP original. |
| `response_body` | `jsonb` | Respuesta original saneada; no guardar signed URLs o secretos de corta duración como respuesta reutilizable. |
| `resource_type` | `varchar(80) NULL` | Tipo de recurso creado. |
| `resource_id` | `uuid NULL` | ID resultado. |
| `created_at` | `timestamptz` | UTC. |
| `expires_at` | `timestamptz` | 24 horas después de la creación. |

**Constraints:** `UNIQUE(actor_scope,idempotency_key_hash)`; antes de expiración, misma clave + mismo hash devuelve respuesta original, misma clave + distinto hash produce `409`; expiración 24 h.
**Índices:** `UNIQUE(actor_scope,idempotency_key_hash)`; `(expires_at)` para limpieza.
**Relaciones:** actor/usuario se resuelve desde `actor_scope` o mediante una FK opcional si se decide normalizarlo; recurso creado es relación lógica polimórfica.

### 15.2 `ExchangeRate` — `exchange_rates`

**Acceso:** lectura pública de la tasa aplicada; escritura admin/proceso verificado. **Sync:** no.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | PK server. |
| `base_currency` | `char(3)` | `USD`. |
| `quote_currency` | `char(3)` | `NIO`. |
| `rate` | `numeric(14,8)` | NIO por USD, positiva. |
| `source_name` | `varchar(180)` | Fuente de la tasa. |
| `source_reference` | `varchar(500) NULL` | URL o identificador documental. |
| `effective_at` | `timestamptz` | Inicio de vigencia. |
| `captured_at` | `timestamptz` | Momento de captura por sistema/admin. |
| `is_approved` | `boolean` | No se publica si no está aprobado. |

**Constraints:** `rate > 0`; solo USD/NIO para esta conversión; fuente obligatoria; tasa no aprobada no puede usarse en respuestas públicas.
**Índices:** `(base_currency,quote_currency,effective_at DESC)`; `(is_approved,effective_at DESC)`.
**Relaciones:** independiente; referenciada por snapshot lógico en `Payment`/`Invoice` y por respuesta API.

## 16. Restricciones globales e índices de sistema

### 16.1 XOR de `ServiceOffering`

Regla de base de datos obligatoria:

`(workshop_id IS NOT NULL) <> (assistance_provider_id IS NOT NULL)`

Adicionalmente, cada FK debe ser compuesta con `user_id` y referenciar una clave única `(id,user_id)` en `workshops` o `assistance_providers`. Así se impide asignar un `user_id` que no sea propietario del target. El constraint `CHECK` impide cero dueños o dos dueños.

La misma regla de target XOR se aplica a `Review` y `AdCampaign` aunque son entidades diferentes.

### 16.2 Secuencia y triggers sync

Objeto global: `sync_version_seq BIGINT`. Cada tabla SYNC-READY debe registrar. En B5S la proyección singleton `profile` usa `users.sync_version` y trigger propio porque el ID de identidad sigue siendo server-generated; `Reminder` se consume pull-only y no es editable desde `/sync/push`.

- Trigger de inserción/actualización que asigna `nextval('sync_version_seq')` a `sync_version`.
- Trigger/función que fija `updated_at` en UTC en cada modificación.
- Trigger o constraint de inmutabilidad donde aplique, por ejemplo `ConsentLog` append-only.

Los triggers se crean en migraciones SQL versionadas. La secuencia no se reinicia ni se baja durante rollback ordinario; los saltos son aceptables. Las tablas no sincronizables no consumen `sync_version`.

### 16.3 Borrado y retención

El API marca `deleted_at`, registra auditoría y devuelve tombstone en sync. Las FK relevantes evitan borrar físicamente padres usados por hijos. La purga física se realiza solo desde un proceso de retención aprobado, con revisión de referencias S3 y restricciones de conservación. No se configura `ON DELETE CASCADE` para eliminar datos de usuario de forma accidental.

### 16.4 Índices PostGIS

- `workshops.location`: GiST.
- `assistance_providers.base_location`: GiST.
- `assistance_requests.location`: GiST parcial cuando `location IS NOT NULL`.
- Polígonos administrativos si se incorporan: GiST sobre la columna geométrica.

Filtros de radio usan `ST_DWithin`; `ST_Distance` queda para orden/cálculo posterior; `ST_Contains` se usa para la semántica de contención que corresponda.

## 17. Puntos pendientes

1. Mantener documentada la distinción entre contenido editable sync-ready y registros técnicos que incluyen `user_id` solo para aislamiento operativo.
2. Definir la fuente y la cadencia de `ExchangeRate`.
3. Definir el tratamiento de facturación B2B con contador/asesoría local; validar requisitos con abogado/contador local.
4. Definir tiempos de retención de `ProcessedMutation`, `AuditLog`, notificaciones y documentos tras revisión legal.
5. Determinar si el usuario puede modificar/eliminar reseñas y en qué ventana; documentar moderación.
6. Definir tamaños máximos y allow-list final de MIME para documentos, fotos y comprobantes.
7. El directorio y la edición offline de talleres/proveedores quedan fuera de B5S; requieren un contrato independiente antes de habilitar sincronización para cuentas de negocio.


## Tabla técnica interna creada por B0

### `FoundationMetadata` — `foundation_metadata`

No pertenece a los dominios de producto, no es propiedad de un usuario y no es sync-ready. Su función en B0 es proporcionar una tabla mínima para validar la migración y el acceso DML del rol runtime.

| Campo | Tipo | Reglas/uso |
|---|---|---|
| `id` | `uuid` | PK; generado por base de datos para esta tabla técnica. |
| `key` | `varchar(120)` | Obligatorio y único. |
| `value` | `jsonb NULL` | Metadato libre. |
| `created_at` | `timestamptz` | Default `clock_timestamp()`. |
| `updated_at` | `timestamptz` | Actualización técnica desde Prisma. |

**Índices:** PK en `id`, UNIQUE en `key`. **Relaciones:** ninguna.

**Actualización B3 de `vehicles`:** `plate_aad_version` (integer, default 1) y `vin_aad_version` (integer nullable) permiten leer filas cifradas con AAD legacy v1 y nuevas escrituras vinculadas a propietario/registro con AAD v2. La migración asigna v1 a VIN preexistentes; el trigger de sincronización sigue asignando `sync_version`.

## Addendum B6 — Directorio de talleres (2026-11-13)

Este addendum prevalece sobre los campos/estados de las secciones 8.1–8.4 anteriores cuando difieran:

- `Workshop.status` usa `draft`, `pending_verification`, `active`, `suspended`; únicamente `active` es visible públicamente. El perfil incorpora `email_ciphertext` y su metadata, `address` independiente de `address_reference_text`, `weekly_schedule JSONB`, `rating_average` y `rating_count`. `phone`, `whatsapp` y `email` se cifran con AAD v2. Las columnas de contacto pueden ser nulas durante `draft`; una restricción SQL impide activar sin dirección, referencia local, ubicación y municipio/departamento; los campos phone/WhatsApp/email son opcionales y se cifran cuando se proporcionan.
- `WorkshopSpecialty` y `WorkshopPhoto` tienen UUID v7, `user_id`, timestamps, soft delete y `sync_version`. El checksum de fotografía puede permanecer nulo hasta que el flujo de almacenamiento pueda obtenerlo de forma verificable.
- `ServiceOffering` utiliza `price_min`, `price_max`, `currency` (USD canónico), `unit`, `notes`, `last_updated_at`, `is_active` y `publication_status`. Se añade `CHECK` para rango válido, moneda USD y exactamente un dueño. Las FKs compuestas con `user_id` impiden que el propietario se suplante.
- `AssistanceProvider` existe en B6 con los campos relacionales mínimos necesarios para la FK XOR de ofertas; el perfil y API públicos del proveedor se implementarán en su fase.
- `WorkshopContactEvent` es técnico y no sync-ready; contiene únicamente taller, tipo `call|whatsapp|route_click` y fecha. No conserva identificadores del visitante.
- Los talleres y sus subregistros conservan triggers de `sync_version` como metadata para una futura sincronización B2B, pero no se agregan a los canales/allow-list del conductor B5S.
- `workshops.location` usa `geography(Point,4326)` y GiST. Búsqueda usa `ST_DWithin`; `search_document` usa TSVECTOR generado e índice GIN. Horario se interpreta exclusivamente en `America/Managua`.
