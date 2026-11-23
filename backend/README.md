# Vehicular Assistance API

> La API ahora está en `backend/`. Los comandos npm de este documento se ejecutan desde esta carpeta. Para infraestructura y arranque del proyecto completo, consultar [el README principal](../README.md). Los contratos compartidos están en [../docs](../docs/README.md).

Backend de la aplicación móvil gratuita de gestión vehicular y asistencia en carretera para Nicaragua.

## Dependencias y auditoría

Se mantiene Prisma 7. `package.json` aplica un override limitado a `@prisma/config` para instalar `effect@3.22.1`, que corrige [GHSA-7589-6fvf-x4pw](https://github.com/advisories/GHSA-7589-6fvf-x4pw). El lockfile conserva esa resolución para `npm ci`. Revisar y retirar el override cuando Prisma incluya una versión corregida directamente. El check `npm audit --audit-level=high` permanece activo; los avisos moderados de otras herramientas requieren una revisión separada antes de actualizar versiones mayores.

## Estado B8

B8 implementa reseñas y calificaciones de talleres. Cada usuario puede reseñar el mismo taller una vez cada seis meses; el comentario admite hasta 500 caracteres, toda reseña pasa por moderación administrativa y el filtro básico prioriza expresiones ofensivas. El propietario solo puede responder una vez o reportar reseñas de su taller. Los reportes requieren motivo y se gestionan desde administración.

- Consulta pública: `GET /api/v1/workshops/:workshopId/reviews` incluye reseñas publicadas, respuestas, promedio y total.
- Crear reseña: `POST /api/v1/reviews` (rol `user`); la reseña inicia `pending`.
- Responder: `POST /api/v1/workshops/:workshopId/reviews/:reviewId/reply` (dueño del taller).
- Reportar: `POST /api/v1/reviews/:reviewId/reports` (usuario o dueño del taller, con motivo).
- Moderación: `GET /api/v1/admin/reviews/moderation-queue`, `PATCH /api/v1/admin/reviews/:reviewId/moderation`, `GET /api/v1/admin/reviews/reports` y `PATCH /api/v1/admin/reviews/reports/:reportId` (solo admin).
- PostgreSQL protege reseñas contra edición y borrado físico. Un trigger recalcula `rating_average` y `rating_count` dentro de la misma transacción que aprueba o retira una reseña; ambos campos no admiten escrituras directas de endpoints de taller o publicidad.
- La prueba `test/unit/reviews.authorization.spec.ts` cubre el escenario de taller con campaña activa y verifica que el propietario solo tenga rutas POST de respuesta/reporte, sin rutas de edición, eliminación o moderación.

**Migración:** `prisma/migrations/20261113150000_b8_reviews_ratings/` (incluye `rollback.sql`). **Contrato:** `docs/b8-review-ratings.md`.

**Validación:** la implementación no se ha ejecutado contra PostgreSQL. No se ejecutaron instalación npm, Prisma Generate/Validate, tests, build ni Docker; se mantiene la decisión de reservar la validación integral para el cierre posterior.

## Estado B7

B7 completa el módulo de proveedores y solicitudes de asistencia en carretera sobre B6/B5S. Incorpora perfiles de proveedores con teléfono y WhatsApp cifrados, cobertura `MultiPolygon` PostGIS con GiST, verificación administrativa, búsqueda por cobertura/servicio/disponibilidad/distancia, paquete offline de emergencia (límite estricto de 99.999 bytes y TTL de siete días en el cliente), historial y solicitudes sincronizables. Las notificaciones se despachan con BullMQ mediante adaptador `mock` o Twilio; los cambios de estado del proveedor se confirman con enlaces hashados de un solo uso y vencimiento. No existe cobro para el conductor.

- Búsqueda pública: `GET /api/v1/assistance-providers/search?lat=&lng=&service_type_id=`; cuando no hay cobertura devuelve `providers: []` y los números generales que estén verificados en el catálogo.
- Paquete offline: `GET /api/v1/assistance-providers/offline-emergency-package?lat=&lng=`; devuelve fecha de generación, expiración, teléfonos resumidos y números oficiales verificados.
- Gestión de proveedor: `POST/PATCH /api/v1/assistance-providers`, `POST /api/v1/assistance-providers/:id/submit-verification` y `PATCH /api/v1/admin/assistance-providers/:id/status`.
- Solicitudes: `POST /api/v1/assistance-requests`, `GET /api/v1/assistance-requests/mine`, detalle y cancelación. Una referencia textual es obligatoria; `pending_envio` solo existe en el dispositivo hasta sincronizar, el servidor guarda `created`.
- Acciones proveedor: `GET /api/v1/assistance-actions/:token` muestra la confirmación; `POST /api/v1/assistance-actions/:token/confirm` consume el enlace.
- Configuración B7: `ASSISTANCE_NOTIFICATION_MODE`, `ASSISTANCE_ACTION_TOKEN_TTL_SECONDS`, `ASSISTANCE_REQUEST_MAX_PER_HOUR`, `PUBLIC_API_BASE_URL`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_FROM` y opcional `TWILIO_WHATSAPP_FROM`.

**Requisito operativo antes de producción:** cargar y verificar al menos un número oficial de emergencia general con su fuente en `EmergencyNumber`. El backend no inventa el número; si no existe registro verificado de categoría general, `emergency_alternative` será una lista vacía.

**Validación:** la sintaxis TypeScript se revisó estáticamente. No se ejecutaron tests, cobertura, build, migraciones, Docker ni pruebas con PostgreSQL/Redis/Twilio; la instalación npm tampoco pudo completarse por disponibilidad de paquetes.

## Estado B6

B6 incorpora el directorio público de talleres, perfiles cifrados, especialidades, fotografías S3, ofertas de servicio, búsqueda PostGIS y métricas de contacto sin datos personales del visitante. La migración es `prisma/migrations/20261113110000_b6_workshop_directory/`.

- Búsqueda pública: `GET /api/v1/workshops/search` con radio, especialidad, municipio, texto y abierto ahora; máximo 50 resultados, `fetched_at` y `cache_ttl_seconds`.
- Gestión: crear/editar ficha, solicitud de verificación, activación por admin, especialidades y fotos. Solo talleres activos aparecen en el directorio.
- `ServiceOffering` garantiza un único dueño desde un `CHECK` SQL y FKs compuestas; todas las respuestas públicas con precio incluyen el texto legal y `price_status` se actualiza por edad de más de 90 días.
- 5 000 fichas sintéticas están aisladas en `NODE_ENV=test`; nunca se incluyen en seeds de desarrollo/producción.
- B9 integra planes y campañas publicitarias. La búsqueda conserva el orden orgánico relativo y antepone campañas activas con pago confirmado. La meta <300 ms a 5 km está preparada, pero no medida aún. Ver [docs/b9-advertising.md](../docs/b9-advertising.md).

No se ejecutaron instalaciones, tests, builds, migraciones, Docker ni pruebas de rendimiento en esta fase; esas comprobaciones se reservan para la validación integral posterior solicitada.

## Estado B5S

B5S incorpora la sincronización offline-first del conductor en NestJS, con bootstrap paginado, pull incremental por canal, push idempotente, resolución LWW, tombstones y sesión de dispositivo. La implementación Flutter/SQLite queda para el proyecto móvil; no se incluye en este backend. El alcance de la fase no incluye sincronización offline B2B para talleres/proveedores.

- Endpoints nuevos: `GET /api/v1/sync/status`, `GET /api/v1/sync/bootstrap`, `GET /api/v1/sync/pull` y `POST /api/v1/sync/push`.
- `sync_channel_states` mantiene un cursor independiente por dispositivo y canal (`all`, `profile`, `vehicles`, `documents`, `policies`, `notification_preferences`, `emergency_contacts`, `assistance_requests`, `reminders`).
- `ProcessedMutation` conserva cifrado el resultado idempotente durante al menos 180 días; no se agrega purga automática en esta fase.
- Cursores y tokens de bootstrap son opacos y firmados; la secuencia `sync_version` nunca se recibe del cliente como cursor.
- Perfil es una proyección limitada de `User`: solo `display_name` y email no verificado se pueden editar por sync; la identidad sigue siendo server-generated.
- `Reminder`, `NotificationLog`, catálogos y `ConsentLog` no admiten escritura móvil. Los recordatorios son pull-only; el historial se consulta en `/api/v1/notifications`.
- Tamaños máximos: 50 mutaciones, 256 KiB por mutación y 12.5 MiB por lote; bootstrap 24 h y cursores 90 días. La purga física de tombstones/resultados idempotentes y la app Flutter/SQLite quedan fuera de B5S; los cursores vencidos requieren bootstrap nuevo.
- Solo sincronizan cuentas conductor. La ventana de solapamiento es de 5,000 versiones y reduce, pero no elimina matemáticamente, el riesgo de commits fuera de orden.

La migración B6 es `prisma/migrations/20261113110000_b6_workshop_directory/` y dispone de `rollback.sql`; el contrato está en `docs/b6-workshop-directory.md`. La prueba de XOR/activación a nivel SQL está preparada en `test/migrations/b6-service-offering-xor.sql` y no se ha ejecutado.

La migración B5S es `prisma/migrations/20261109100000_b5s_offline_sync/` y dispone de `rollback.sql`. La vigencia de 90 días corresponde al cursor; la tabla de estado permite que una futura tarea privilegiada invalide cursores antiguos, pero esta fase no purga tombstones ni resultados idempotentes automáticamente. La comprobación de instalación, compilación, pruebas y migración queda para la revisión integral posterior de todas las fases.

## Estado B5

B0 establece la fundación, B1 incorpora autenticación/identidad, B2 implementa vehículos y catálogos, B3 incorpora documentos y pólizas, B4 implementa recordatorios/notificaciones y B5 agrega catálogos nacionales y datos de emergencia.

- Módulos creados: `auth`, `users`, `vehicles`, `documents`, `reminders`, `catalogs`, `sync`, `workshops`, `providers`, `reviews`, `ads`, `billing` y `admin`; los dominios con lógica implementada incluyen `auth`, `users`, `vehicles`, `documents`, `reminders`, `emergency`, catálogos nacionales y administración de números de emergencia.
- PostgreSQL 16 + PostGIS + pgcrypto y Redis mediante Docker Compose.
- Roles separados: `app_migrator` para DDL/migraciones y `app_runtime` para acceso DML de la API.
- Prisma ORM 7 con `@prisma/adapter-pg`; el pool (`max`, `connectionTimeoutMillis`) y el esquema se configuran con opciones nativas del adaptador, no mediante parámetros antiguos del Query Engine. La API usa únicamente `DATABASE_URL` con `app_runtime`; el proceso de migración aislado usa `DATABASE_MIGRATION_URL` con `app_migrator`. El contenedor API no recibe la credencial de migración.
- Configuración tipada validada al arrancar, DTO validation global, errores JSON uniformes, `request_id`, CORS allow-list y rate limiting Redis global (IP para rutas públicas; usuario+dispositivo para rutas autenticadas). OTP añade límite horario por número con clave HMAC.
- `GET /health` y Swagger en `/docs`.
- Migraciones B0/B1/B2/B3/B4/B5/B5S/B6 con scripts SQL de reversa documentados; B4 agrega recordatorios/preferencias/logs y versión AAD v2 para tokens FCM.
- JWT access/refresh HS256, rotación con detección de reutilización, OTP Twilio Verify SMS/WhatsApp y mock solo dev/test.
- Perfil `GET/PATCH /me`, registro FCM `POST /me/devices`, exportación `GET /me/export` y eliminación `DELETE /me`.
- Cifrado AES-256-GCM con envelope encryption KMS en producción, HMAC ciego separado, y limpieza de los prefijos S3 privados de usuario/exportaciones.
- GitHub Actions: lint, tests, generación Prisma, build y construcción de imagen Docker.

Las reseñas y calificaciones de talleres están incorporadas en B8. Las campañas patrocinadas y cobros B2B quedan para sus fases posteriores. El directorio está en B6 y la asistencia en carretera en B7. Los endpoints B2, B3, B4 y B5 se detallan más abajo.

## Requisitos

- Node.js 22.16.x y npm 10.9.x.
- Docker Engine con Docker Compose v2.
- Acceso al registro npm durante la instalación inicial.

## Inicio local con Docker Compose

1. Copiar `.env.example` a `.env` y mantener valores solo de desarrollo. Los secretos incluidos en el ejemplo son ficticios y no deben usarse fuera de una máquina local. El contenedor `api` recibe exclusivamente la configuración runtime; el job `migrate` recibe la URL de `app_migrator`.

   ```bash
   cp .env.example .env
   ```

2. Levantar PostgreSQL/PostGIS, Redis y la API:

   ```bash
   docker compose up --build -d
   ```

   La inicialización de una base vacía crea `app_migrator`, `app_runtime` y habilita `postgis` y `pgcrypto`. Los scripts de inicialización del contenedor PostgreSQL se ejecutan una sola vez por volumen.

3. Aplicar las migraciones versionadas explícitamente con el rol `app_migrator`:

   ```bash
   docker compose --profile tools run --rm migrate
   ```

   La API no ejecuta migraciones automáticamente al arrancar.

4. Comprobar los servicios:

   - API y dependencias: `http://localhost:3000/health`
   - Swagger: `http://localhost:3000/docs`

   `/health` está fuera del prefijo de negocio por ser un endpoint de infraestructura. Las rutas de negocio futuras usarán `/api/v1`.

## Ejecución desde el host

Tras copiar `.env.example` a `.env` y levantar solo las dependencias con `docker compose up -d db redis`, instalar y ejecutar:

```bash
npm install
npm run prisma:generate
DATABASE_MIGRATION_URL="postgresql://app_migrator:migrator_dev_only@localhost:5432/vehicular_dev?schema=public" npm run db:migrate
npm run start:dev
```

El `.env` local apunta a `localhost`. Para migrar desde el host, proporciona `DATABASE_MIGRATION_URL` solo en el comando como se muestra arriba; no la guardes en `.env`, porque la API no debe recibir la credencial DDL. Docker Compose reemplaza la URL runtime por el nombre interno `db`; el job de migración recibe únicamente la URL directa de `app_migrator`.

## Comandos útiles

```bash
npm run lint
npm run test:ci
npm run test:migrations
npm run build
npm run db:status
DATABASE_MIGRATION_URL="postgresql://app_migrator:migrator_dev_only@localhost:5432/vehicular_dev?schema=public" npm run db:seed
```

`test:ci` incluye pruebas de integración con Testcontainers y requiere Docker disponible. `test:migrations` aplica la migración en PostGIS, verifica el trigger global `sync_version`, ejecuta `rollback.sql` y comprueba que los objetos propios de la migración fueron retirados.

Los seeds incorporan el catálogo base de marcas/modelos y los 17 departamentos/regiones y 153 municipios de Nicaragua, además de tipos de servicio y especialidades, de forma idempotente en desarrollo, pruebas y producción. No se agregan teléfonos de emergencia sin verificación documental. Los seeds se ejecutan con `DATABASE_MIGRATION_URL` y el rol `app_migrator`; los catálogos no se modifican con el rol runtime.

## Variables y secretos

La referencia completa está en `.env.example` y en `docs/architecture.md`. La validación de arranque de la API comprueba:

- presencia y formato de las variables base;
- usuario `app_runtime` en `DATABASE_URL`; el comando de migración valida aparte `DATABASE_MIGRATION_URL` y exige `app_migrator`;
- zona horaria `America/Managua`;
- orígenes CORS explícitos;
- claves locales AES/HMAC de 32 bytes en Base64 para desarrollo/pruebas;
- en producción: PostgreSQL con `verify-full`, Redis TLS, KMS, Twilio Verify y ausencia de claves locales.

No se versionan `.env` ni secretos. Producción debe inyectar credenciales mediante IAM/secret manager. Las claves ficticias del ejemplo son exclusivamente para desarrollo local.

## Endpoints B1

| Método | Ruta | Acceso | Propósito |
|---|---|---|---|
| POST | `/api/v1/auth/otp/request` | Público, rate-limited | Solicitar OTP SMS/WhatsApp |
| POST | `/api/v1/auth/otp/verify` | Público, requiere OTP + consentimiento | Alta/login y emisión JWT ligados a `device_id` |
| POST | `/api/v1/auth/refresh` | Público, requiere refresh JWT | Rotación de refresh token |
| POST | `/api/v1/auth/logout` | Público, requiere refresh JWT | Revocar familia y dispositivo |
| GET | `/api/v1/me` | Bearer | Leer perfil propio |
| PATCH | `/api/v1/me` | Bearer | Actualizar nombre visible/correo |
| POST | `/api/v1/me/devices` | Bearer | Registrar/rotar token FCM cifrado |
| GET | `/api/v1/me/export` | Bearer | Exportar identidad, consentimiento y dispositivos disponibles en B1 |
| DELETE | `/api/v1/me` | Bearer | Eliminar/anonimizar identidad y archivos de prefijos personales |

El contrato completo de requests, responses y errores está en [`docs/auth-contract.md`](../docs/auth-contract.md). La exportación/eliminación integral de dominios se completa cuando esos dominios se incorporen en sus fases.

## PostgreSQL y sincronización

La migración B0 crea `sync_version_seq` con `CACHE 1` y `assign_sync_metadata()`. B5S agrega `users.sync_version` para la proyección limitada del perfil, `assistance_requests` y las tablas técnicas `sync_channel_states`, `sync_bootstraps`, `sync_retention_state` y `processed_mutations`. La API asigna versiones desde PostgreSQL; los cursores son opacos y firmados. No se aplica el trigger a tablas técnicas ni a catálogos de solo lectura.

Cada migración futura debe tener un `rollback.sql` específico. La reversa de esta fundación es para entornos de prueba aislados; producción mantiene la estrategia expandir/contraer y corrección hacia adelante aprobada.

## Estructura principal

```text
src/
  config/          # Configuración tipada y bootstrap HTTP
  common/          # Filtro, request_id, logging, guards y decoradores
  database/        # Prisma y convención sync-ready
  redis/           # Cliente Redis y rate limiting
  health/          # Health check API/BD/Redis
  modules/         # Módulos de dominio vacíos de B0
prisma/
  migrations/      # Migraciones versionadas y rollbacks documentados
  seeds/           # Seeds por entorno
  templates/       # Plantilla SQL sync-ready
scripts/
  init-db/         # Roles y extensiones del PostgreSQL local
  test-migrations.cjs
  require-migration-url.cjs
test/
  unit/
  e2e/
docs/
  architecture.md
  data-dictionary.md
  decisions.md
  offline-sync-contract.md
  auth-contract.md
  sync-ready-template.md
  technical-findings.md
  documents-contract.md
```

## Registro de hallazgos

Los puntos extraños o que requieren validación de decisiones se registran en `docs/technical-findings.md` con prioridad **urgente**, **moderado** o **no tan urgente**. No se cambian decisiones de P1/P2 ni contratos de futuras fases sin aprobación.

## Repositorio Git

El proyecto se inicializa como repositorio Git local con rama `main`. No se configuró remoto GitHub porque todavía no se proporcionó propietario/nombre del repositorio ni credencial de publicación. El workflow `/.github/workflows/ci.yml` está listo para ejecutarse al conectar el remoto.


## Endpoints B2

| Método | Endpoint | Acceso | Descripción |
|---|---|---|---|
| POST | `/api/v1/vehicles` | Bearer | Crear vehículo con UUID v7 del cliente; la misma creación reenviada se responde idempotentemente (`200` en replay). |
| GET | `/api/v1/vehicles` | Bearer | Listar vehículos propios con cursor y límite máximo de 50. |
| GET | `/api/v1/vehicles/:id` | Bearer + propietario | Consultar vehículo propio. |
| PATCH | `/api/v1/vehicles/:id` | Bearer + propietario | Actualizar vehículo propio. |
| DELETE | `/api/v1/vehicles/:id` | Bearer + propietario | Borrado lógico y ocultación de documentos asociados. |
| GET | `/api/v1/vehicles/:id/summary` | Bearer + propietario | Conteo de documentos y siguiente vencimiento. |
| POST | `/api/v1/vehicles/:id/photo/upload-url` | Bearer + propietario | Solicitar URL firmada para foto. |
| POST | `/api/v1/vehicles/:id/photo/confirm` | Bearer + propietario | Verificar la subida y marcar la foto disponible. |
| GET | `/api/v1/catalogs/vehicle-brands` | Público | Catálogo de marcas con ETag y versión. |
| GET | `/api/v1/catalogs/vehicle-models` | Público | Catálogo de modelos con filtro opcional `brand_id`, ETag y versión. |

Los detalles de campos, errores e idempotencia están en [`docs/vehicles-contract.md`](../docs/vehicles-contract.md).

## Endpoints B3 — documentos y pólizas

| Método | Endpoint | Acceso | Descripción |
|---|---|---|---|
| GET | `/api/v1/vehicles/:vehicle_id/documents` | Bearer + propietario | Listar documentos activos del vehículo. |
| POST | `/api/v1/vehicles/:vehicle_id/documents` | Bearer + propietario | Registrar documento con `file_status=pendiente_subida`. |
| GET | `/api/v1/documents/:id` | Bearer + propietario | Consultar documento propio. |
| POST | `/api/v1/documents/:id/upload-url` | Bearer + propietario | Solicitar PUT firmado para PDF/JPG/PNG/HEIC, máximo 10 MB. |
| POST | `/api/v1/documents/:id/confirm` | Bearer + propietario | Verificar tamaño/MIME/magic bytes y cambiar a `disponible`. |
| POST | `/api/v1/documents/:id/download-url` | Bearer + propietario | Crear GET firmado temporal para archivo disponible. |
| GET | `/api/v1/vehicles/:vehicle_id/policies` | Bearer + propietario | Consultar póliza y su historial de renovaciones. |
| POST | `/api/v1/vehicles/:vehicle_id/policies` | Bearer + propietario | Crear póliza y archivar la anterior si existe. |
| GET | `/api/v1/catalogs/insurers` | Público | Catálogo de aseguradoras versionado con ETag. |

`DOCUMENT_EXPIRING_SOON_DAYS` configura el umbral `por_vencer` (default 30 días). El número de póliza y teléfono de siniestros se cifran con AES-256-GCM y AAD v2 por usuario/registro. Los detalles completos están en [`docs/documents-contract.md`](../docs/documents-contract.md).


## B4 — Recordatorios y notificaciones

B4 agrega `Reminder`, `NotificationPreference` y `NotificationLog`, agenda de 90 días para el cliente móvil, preferencias por offsets/hora/canales y worker BullMQ sobre Redis con Firebase Cloud Messaging. Los recordatorios se generan al crear/editar documentos y renovar pólizas; cambios de vigencia/preferencias cancelan y regeneran los pendientes transaccionalmente.

Consulta `docs/reminders-contract.md` para el contrato, zona horaria, configuración FCM y límites de idempotencia. En desarrollo usar `FCM_MODE=mock`; producción requiere `FCM_MODE=firebase`, `FIREBASE_PROJECT_ID` y `FIREBASE_SERVICE_ACCOUNT_BASE64`.

Endpoints B4: `GET /api/v1/reminders/schedule`, `GET/PATCH /api/v1/me/notification-preferences`, `GET /api/v1/notifications`, `PATCH /api/v1/notifications/:id/read` y `PATCH /api/v1/documents/:id`.


## B5 — Catálogos y datos de emergencia

B5 agrega `EmergencyNumber`, `EmergencyContact`, `ServiceType`, `Specialty`, `Department` y `Municipality`. Los catálogos públicos ofrecen versión y ETag, con un endpoint único de estado y caché Redis por versión. El catálogo territorial incluye 15 departamentos, 2 regiones autónomas y 153 municipios; sus códigos son claves internas, no códigos estadísticos oficiales.

Los números de emergencia son editables por admin (`/admin/emergency-numbers`) y solo aparecen al público cuando `verified=true`, con fuente, fecha y usuario verificador. No se sembraron números telefónicos porque aún no se ha validado una lista oficial para publicar. Los contactos personales se cifran con AAD v2 y se limitan a cinco por usuario.

Endpoints B5: `GET /api/v1/catalogs/status`, `GET /api/v1/catalogs/:name`, CRUD `/api/v1/me/emergency-contacts`, admin CRUD `/api/v1/admin/emergency-numbers` y `POST /api/v1/emergency/share-message`. El último devuelve texto y enlace de WhatsApp con URL de mapa, referencia, vehículo y teléfono de la cuenta; no guarda las coordenadas. Consulta `docs/catalogs-emergency.md` para detalles y fuentes.


### Revisión urgente posterior a B5

Se añadió la migración incremental `20261104160000_emergency_verification_hardening`: cualquier cambio en teléfono, categoría, cobertura o procedencia de un número de emergencia invalida la verificación previa también en SQL directo. El servicio permite revalidar explícitamente en la misma transacción mediante un segundo `UPDATE`.

B6 HTTP performance probe (prepared, not executed): `test/performance/b6-workshop-search.k6.js`.
