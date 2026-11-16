# Arquitectura de datos y conexión

**Producto:** aplicación móvil de gestión vehicular y asistencia en carretera para Nicaragua
**Estado:** propuesta de arquitectura base para revisión y aprobación
**Versión:** 0.1.0
**Fecha:** 2026-11-03
**Alcance:** documentación de arquitectura; no incluye código de aplicación ni implementación de endpoints.

> Este documento es la referencia de arquitectura para las fases posteriores. Las decisiones expresamente confirmadas por el propietario del proyecto se consideran invariantes. Los puntos que aún requieren una decisión se identifican como **PENDIENTE DE APROBACIÓN** y no deben convertirse en supuestos silenciosos de implementación.

## 1. Propósito, límites e invariantes

La solución usa NestJS como única puerta de entrada a los datos y a los proveedores externos. PostgreSQL 16 con PostGIS es la fuente de verdad transaccional. Redis coordina caché, límites y trabajos asíncronos, pero nunca es la fuente de verdad. S3 conserva archivos privados. Twilio Verify se usa para OTP y Firebase Cloud Messaging (FCM) para notificaciones push.

Invariantes del producto:

- El usuario final no paga por utilizar la aplicación. No existen pagos, suscripciones ni compras internas para conductores.
- Los únicos cobros previstos son B2B a talleres, mecánicos y proveedores por publicidad, inicialmente mediante transferencia y comprobante.
- Un precio de servicio publicado al conductor es estimado, debe incluir mínimo y máximo, y toda respuesta que lo presente debe incluir literalmente: **“Precio estimado. El pago se realiza directamente al taller o al proveedor cuando se presta el servicio.”**
- Los contenidos publicitarios pagados se entregan con `patrocinado: true`. La publicidad no modifica puntuaciones, reseñas ni orden orgánico fuera de los espacios publicitarios identificados.
- Se almacenan instantes en UTC (`timestamptz`) y las reglas de calendario/notificación se interpretan en `America/Managua`.
- La moneda canónica es USD. El equivalente NIO es informativo y debe acompañarse de la tasa y fecha utilizadas.
- Las solicitudes de auxilio exigen una referencia de dirección en texto, por ejemplo “de la rotonda, 2 cuadras al lago”. No se inventan números de emergencia.
- Las decisiones de tratamiento de datos personales se implementan con consentimiento versionado, IP/User-Agent cifrados cuando se registran, exportación y flujo de eliminación. Cualquier interpretación legal de la Ley 787 queda **“validar con abogado local”**.
- Los catálogos públicos usan versión/ETag; el cliente consulta `GET /api/v1/catalogs/status` para detectar cambios. Los números de emergencia solo se muestran después de verificación administrativa con fuente documentada; no se inventan ni se publican registros pendientes.
- El cliente móvil futuro no tendrá credenciales de PostgreSQL, Redis, AWS ni FCM server. Solo consumirá la API y utilizará URLs firmadas de S3 emitidas por la API.

## 2. Topología y límites de confianza

### 2.1 Diagrama lógico

```mermaid
flowchart LR
    M[Cliente móvil Flutter futuro]
    API[API NestJS<br/>HTTPS /api/v1]
    PG[(PostgreSQL 16<br/>PostGIS + pgcrypto)]
    POOL[PgBouncer opcional<br/>transaction pooling]
    R[(Redis<br/>caché + BullMQ)]
    S3[(AWS S3<br/>buckets privados)]
    KMS[AWS KMS<br/>CMK + data keys]
    FCM[Firebase Cloud Messaging]
    TW[Twilio Verify<br/>SMS / WhatsApp OTP]

    M <-->|JSON HTTPS / JWT| API
    API -->|Prisma Client| POOL
    POOL --> PG
    API <--> R
    API -->|crear URL firmada| S3
    API -->|GenerateDataKey / Decrypt| KMS
    API -->|FCM Admin / HTTP v1| FCM
    API -->|Verify API| TW
    M -.->|PUT / GET únicamente con URL firmada| S3
```

PgBouncer se puede omitir en desarrollo y pruebas. En producción se recomienda evaluarlo según el número de réplicas y el límite real de conexiones del proveedor PostgreSQL.

### 2.2 Por qué el móvil no accede directamente a PostgreSQL ni a S3 sin firma

**PostgreSQL:** exponer la base de datos permitiría extraer credenciales, evitar guards de rol/propiedad, omitir validación DTO, rate limiting, auditoría, reglas de negocio e idempotencia. Además, expondría la superficie de red y el esquema interno. Toda lectura y escritura pasa por NestJS; el API autentica al usuario, deriva su identidad del JWT y filtra por propietario en cada consulta.

**S3:** una credencial AWS dentro de una aplicación distribuida puede extraerse del paquete móvil. El acceso sin firma permitiría consultar, sobrescribir o borrar objetos fuera de los permisos previstos. El móvil recibe una URL firmada, limitada a un objeto, método HTTP, encabezados permitidos y tiempo breve. La API autoriza la operación antes de emitirla y registra el vínculo entre el objeto y su propietario.

La URL firmada es una credencial temporal y transferible: quien la obtenga puede usarla dentro de su vigencia. Por eso no se registra en logs, analítica, crash reports ni parámetros persistentes. La API no devuelve las claves AWS ni credenciales de larga duración.

### 2.3 Flujo de archivos

```mermaid
sequenceDiagram
    participant App as Móvil
    participant API as NestJS API
    participant DB as PostgreSQL
    participant S3 as S3 privado

    App->>API: Solicitar intención de carga (JWT)
    API->>DB: Validar propietario y crear carga pendiente
    API->>S3: Firmar PUT para key aleatoria
    API-->>App: URL firmada + headers + expiración
    App->>S3: PUT directo usando solo la URL firmada
    App->>API: Confirmar carga (JWT)
    API->>S3: HEAD / verificar tamaño, tipo y checksum
    API->>DB: Asociar object_key al documento
    API-->>App: Estado confirmado

    App->>API: Solicitar descarga (JWT)
    API->>DB: Validar propiedad y estado
    API->>S3: Firmar GET
    API-->>App: URL GET de corta duración
    App->>S3: GET usando URL firmada
```

Cada carga usa una `object_key` aleatoria nueva, nunca el nombre de archivo original como clave. Una carga no se considera documento válido hasta que la API verifica el objeto y registra su asociación. El cliente no elige el bucket ni la clave final.

### 2.4 Componentes y responsabilidades

| Componente | Responsabilidad | No debe hacer |
|---|---|---|
| Flutter (futuro) | Captura, almacenamiento local, cola offline, UX, subida/descarga firmada | Conectarse a PostgreSQL/Redis, guardar secretos AWS o decidir permisos del servidor |
| NestJS | Autenticación, autorización, validación, reglas, serialización, auditoría, integración externa | Delegar controles de propiedad al cliente |
| Prisma Client | Consultas CRUD, transacciones y relaciones ordinarias | Simular soporte nativo de PostGIS donde no exista |
| SQL parametrizado | Operaciones PostGIS y objetos PostgreSQL no expresables en Prisma | Concatenar texto recibido del cliente |
| PostgreSQL/PostGIS | Fuente de verdad, constraints, secuencias, triggers y relaciones | Recibir conexiones desde móviles |
| Redis/BullMQ | Caché temporal de catálogos (TTL 1 h, clave versionada), rate limiting y ejecución/reintento de jobs | Ser el único lugar donde exista una operación o estado de negocio |
| S3 | Documentos, comprobantes y fotos | Hacer públicos objetos privados o aceptar claves elegidas por el usuario |
| AWS KMS | Proteger claves de datos y apoyar rotación | Recibir datos de negocio completos para cifrarlos campo a campo |
| FCM | Transporte de notificaciones push | Ser el registro persistente de notificaciones |
| Twilio Verify | Enviar y comprobar OTP | Usarse como pasarela de pagos o asumirse como servicio general de mensajería transaccional |

## 3. Conexión a PostgreSQL

### 3.1 Prisma y PostGIS

Prisma Client es la capa normal de acceso a PostgreSQL. Se utilizará para CRUD, relaciones, transacciones, filtros ordinarios y consultas tipadas.

Las columnas PostGIS que Prisma no modele como tipos de primera clase se declararán en migraciones SQL y se representarán en el esquema Prisma mediante el mecanismo `Unsupported` correspondiente a la versión fijada. No se degradará la precisión geográfica almacenando latitud/longitud como sustituto de la columna espacial indexada.

Para las consultas geoespaciales se usará SQL crudo parametrizado a través de las APIs seguras de Prisma:

- `ST_DWithin(geography, geography, distance_meters)` para filtrar por radio. Es la operación preferida para “cerca de mí” y puede aprovechar GiST.
- `ST_Contains(polygon, point)` para comprobar contención dentro de polígonos administrativos cuando se requiera esa semántica. Si el caso de negocio necesita incluir puntos exactamente en el borde, evaluar `ST_Covers`.
- `ST_Distance` para calcular/ordenar distancias sobre los candidatos ya filtrados. No usarla sola como filtro inicial de radio cuando `ST_DWithin` sirve para ese propósito.
- Todas las geometrías tendrán SRID 4326. Para distancias expresadas en metros se preferirá `geography(Point,4326)`.

Los valores —coordenadas, radio, identificadores, filtros— se pasan como parámetros. Nunca se construyen sentencias SQL concatenando strings recibidos por HTTP. Los nombres de columnas/orden dinámicos se resuelven con listas permitidas internas, no con texto libre del cliente.

Referencias técnicas: [Prisma raw queries](https://www.prisma.io/docs/orm/reference/raw-queries), [PostGIS spatial indexes](https://postgis.net/documentation/faq/spatial-indexes/) y [PostGIS ST_DWithin](https://postgis.net/documentation/tips/st-dwithin/).

### 3.2 Pool de conexiones

Valores iniciales propuestos por proceso NestJS (se ajustan con pruebas de carga y límites del proveedor):

| Entorno | Pool de Prisma por proceso API | Pool de workers | Notas |
|---|---:|---:|---|
| Desarrollo | 5 | 2 | Un proceso local; no se necesita pooler externo |
| Pruebas | 3–5 | 1–2 | Testcontainers con base aislada; limitar paralelismo de Jest para no agotar el contenedor |
| Producción | 8 | 3 | Punto inicial por réplica; escalar solo calculando el total de conexiones |

El límite global debe calcularse así:

`conexiones_app = réplicas_api × pool_api + réplicas_worker × pool_worker + conexiones_operativas`

Ese total debe mantenerse por debajo del presupuesto de conexiones del servidor, reservando conexiones para administración, migraciones, monitoreo y recuperación. Los valores anteriores son máximos por proceso, no una promesa de concurrencia ilimitada.

**Cuando el pool se agota:** las solicitudes que no obtengan conexión dentro del timeout fallan de forma controlada; la API devuelve un error temporal uniforme (HTTP 503, código interno como `DATABASE_POOL_EXHAUSTED`) con `request_id`. No se dejan solicitudes esperando indefinidamente ni se ejecutan reintentos ciegos sobre escrituras. La observabilidad debe incluir conexiones activas/ociosas, tiempo de espera, timeout del pool, duración de consulta y saturación del servidor. Los reintentos automáticos solo aplican a operaciones idempotentes.

### 3.3 PgBouncer en producción

**Recomendación:** evaluar e incorporar PgBouncer en modo `transaction` si el número de instancias NestJS o workers puede superar el presupuesto de conexiones PostgreSQL. Es especialmente útil cuando hay muchas conexiones cliente de vida larga o escalado horizontal, y permite multiplexar conexiones de aplicación sobre un número menor de conexiones servidor.

Condiciones para usarlo con Prisma:

1. Validar la versión exacta de Prisma ORM y PgBouncer fijada por el proyecto.
2. Usar transaction pooling. No depender de estado de sesión que sobreviva entre transacciones (`SET` de sesión, tablas temporales o locks de sesión).
3. Validar la compatibilidad de prepared statements según versión y configuración de PgBouncer. La documentación de Prisma indica que el parámetro `pgbouncer=true` depende de la versión de PgBouncer; no se debe añadir a ciegas.
4. `prisma migrate deploy` usa una conexión directa de migraciones, no el endpoint de PgBouncer. Separar URL de runtime y URL de migración.
5. Medir límites, timeouts y métricas del pooler antes de establecer valores definitivos.

Si el proveedor PostgreSQL ofrece un pooler administrado equivalente, se evaluará con los mismos criterios. La decisión de usar PgBouncer no cambia las credenciales ni los privilegios de la aplicación.

Referencia: [Prisma ORM — Configure Prisma Client with PgBouncer](https://docs.prisma.io/docs/orm/v7/prisma-client/setup-and-configuration/databases-connections/pgbouncer).

### 3.4 SSL, roles y privilegios

En producción SSL es obligatorio y se debe verificar el certificado del servidor (`verify-full` cuando el proveedor y su CA lo permitan). No se aceptará desactivar la validación TLS para “resolver” errores de conexión.

Se separan dos roles PostgreSQL:

| Rol | Uso | Privilegios |
|---|---|---|
| `app_migrator` | Pipeline CI/despliegue | DDL sobre el esquema de la aplicación, creación/alteración de tablas, índices, funciones, triggers y ejecución de migraciones. No se usa en solicitudes HTTP. |
| `app_runtime` | API y workers | DML mínimo (`SELECT`, `INSERT`, `UPDATE`, y `DELETE` solo donde exista una necesidad documentada para tablas técnicas). Sin `CREATE`, `ALTER`, `DROP`, superusuario ni administración de extensiones. |

Las extensiones se habilitan mediante bootstrap controlado por el rol de migración/administración, nunca con el rol runtime. El rol runtime no modifica el esquema. Los permisos se otorgan por esquema/tabla y se revisan al incorporar nuevas tablas.

En B0, `DATABASE_MIGRATION_URL` se valida por separado al ejecutar `db:migrate` o `db:status`; el contenedor HTTP no recibe esa variable ni la contraseña de `app_migrator`. La URL runtime se adapta a `@prisma/adapter-pg`: `max`, `connectionTimeoutMillis`, `idleTimeoutMillis` y `schema` se configuran en opciones del adaptador, y los parámetros heredados `connection_limit`/`pool_timeout`/`schema` se eliminan de la URL antes de pasarla a `pg`. `DATABASE_SSL_MODE` configura el objeto TLS del driver; en producción se exige verificación de certificado y hostname (`verify-full`).

La autorización por dueño se aplica también en NestJS: cada consulta de un recurso privado incluye el `user_id` autenticado o el dueño del negocio derivado de la relación. No se confía en un `user_id` enviado por el cliente. Se evaluará Row Level Security como defensa adicional cuando se defina cómo fijar de forma segura el contexto de usuario con el pool transaccional; no se considera sustituto de los guards.

### 3.5 Variables de entorno

Los valores de ejemplo son deliberadamente ficticios. No deben copiarse como credenciales reales. Los secretos se inyectan desde el almacén de secretos del entorno o el mecanismo equivalente del proveedor de despliegue; nunca se versionan.

| Variable | Propósito | Ejemplo ficticio |
|---|---|---|
| `NODE_ENV` | Entorno de ejecución | `development` |
| `APP_PORT` | Puerto HTTP de NestJS | `3000` |
| `API_PREFIX` | Prefijo global | `api/v1` |
| `APP_TIMEZONE` | Zona horaria de negocio | `America/Managua` |
| `POSTGRES_DB` | Base local de Docker Compose | `vehicular_dev` |
| `POSTGRES_ADMIN_USER` / `POSTGRES_ADMIN_PASSWORD` | Usuario administrador solo para inicialización local | `postgres_admin` / `REDACTED` |
| `APP_MIGRATOR_PASSWORD` | Contraseña del rol DDL, solo job de migración | `REDACTED` |
| `APP_RUNTIME_PASSWORD` | Contraseña del rol runtime, API | `REDACTED` |
| `REDIS_PASSWORD` | Contraseña Redis local | `REDACTED` |
| `DATABASE_URL` | Conexión runtime de `app_runtime`; la única URL que recibe la API; puede apuntar a PgBouncer | `postgresql://app_runtime:REDACTED@db-dev.example.invalid:5432/vehicular_dev?schema=public` |
| `DATABASE_MIGRATION_URL` | Conexión directa de `app_migrator` para el job/CLI de migraciones; nunca se inyecta al proceso API | `postgresql://app_migrator:REDACTED@db-dev.example.invalid:5432/vehicular_dev?sslmode=require` |
| `DATABASE_POOL_MAX` | Máximo de conexiones del pool Prisma por proceso | `5` |
| `DATABASE_POOL_TIMEOUT_SECONDS` | Espera máxima por conexión | `10` |
| `DATABASE_SSL_MODE` | Política SSL | `verify-full` |
| `DATABASE_CA_CERT_PATH` | CA del servidor PostgreSQL, si aplica | `/run/secrets/postgres-ca.pem` |
| `REDIS_URL` | Redis para caché, rate limit y BullMQ | `rediss://default:REDACTED@redis-dev.example.invalid:6380` |
| `REDIS_TLS_REQUIRED` | Requerir TLS hacia Redis | `false` en local; `true` en producción |
| `ASSISTANCE_NOTIFICATION_MODE` | Transporte de notificación B7 (`mock` o `twilio`) | `mock` en desarrollo/test; `twilio` en producción |
| `ASSISTANCE_ACTION_TOKEN_TTL_SECONDS` | Vigencia del enlace de acción de proveedor | `86400` (máximo 24 h) |
| `ASSISTANCE_REQUEST_MAX_PER_HOUR` | Máximo de solicitudes de asistencia por usuario/hora | `3` |
| `PUBLIC_API_BASE_URL` | URL pública que incluye `/api/v1`, utilizada en enlaces de acción | HTTPS obligatorio en producción |
| `TWILIO_SMS_FROM` / `TWILIO_WHATSAPP_FROM` | Senders E.164 para SMS y WhatsApp de B7 | Solo cuando se activa Twilio; sender WhatsApp opcional |
| `AWS_REGION` | Región AWS | `us-east-1` |
| `AWS_S3_PRIVATE_BUCKET` | Bucket privado del entorno | `vehicular-dev-private-001` |
| `AWS_S3_PRESIGN_UPLOAD_TTL_SECONDS` | Vigencia de URL PUT | `300` |
| `AWS_S3_PRESIGN_DOWNLOAD_TTL_SECONDS` | Vigencia de URL GET | `600` |
| `AWS_KMS_KEY_ARN` | Clave maestra KMS para cifrado por envoltura AES-256-GCM | `arn:aws:kms:us-east-1:111122223333:key/00000000-0000-4000-8000-000000000001` |
| `AWS_KMS_BLIND_INDEX_KEY_ARN` | Clave KMS HMAC_256 independiente para índices ciegos (`GenerateMac`) | `arn:aws:kms:us-east-1:111122223333:key/00000000-0000-4000-8000-000000000002` |
| `S3_CLEANUP_MODE` | Modo de purga S3 (`mock` dev/test; `s3` prod) | `mock` |
| `ENCRYPTION_MODE` | Modo de claves para el entorno | `local` (dev/test); `kms` (producción) |
| `LOCAL_DATA_KEY_BASE64` | Clave local de datos de prueba | `AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=` (solo ejemplo; generar una clave distinta por entorno) |
| `LOCAL_BLIND_INDEX_KEY_BASE64` | Clave local HMAC de prueba | `AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=` (solo ejemplo; generar una clave distinta por entorno) |
| `TWILIO_ACCOUNT_SID` | Cuenta Twilio | `AC00000000000000000000000000000000` |
| `TWILIO_AUTH_TOKEN` | Secreto Twilio | `REDACTED_FAKE_TOKEN` |
| `TWILIO_VERIFY_SERVICE_SID` | Servicio Verify | `VA00000000000000000000000000000000` |
| `OTP_MODE` | Proveedor OTP | `mock` (dev/test); `twilio` (producción) |
| `OTP_MOCK_CODE` | Código fijo de pruebas; solo existe en dev/test | `123456` |
| `OTP_CODE_TTL_SECONDS` | Vigencia del challenge OTP | `300` |
| `OTP_MAX_REQUESTS_PER_HOUR` | Solicitudes por número por ventana de una hora | `5` (valor inicial B1) |
| `OTP_MAX_FAILED_ATTEMPTS` | Intentos fallidos; fijado exactamente en 5 por regla de negocio | `5` |
| `OTP_LOCK_MINUTES` | Bloqueo temporal después del quinto intento | `15` (valor inicial B1) |
| `CONSENT_POLICY_VERSION` | Versión vigente de política exigida en alta | `privacy-2026-11-v1` |
| `FCM_PROJECT_ID` | Proyecto Firebase | `vehicular-demo-fake` |
| `FCM_CREDENTIALS_JSON` | Credencial de servicio Firebase inyectada como secreto | `REDACTED_FAKE_SERVICE_ACCOUNT_JSON` |
| `JWT_ACCESS_SECRET` | Firma access token | `REDACTED_FAKE_ACCESS_SECRET` |
| `JWT_REFRESH_SECRET` | Firma/derivación refresh token | `REDACTED_FAKE_REFRESH_SECRET` |
| `JWT_ACCESS_TTL_SECONDS` | Duración access token | `900` |
| `JWT_REFRESH_TTL_SECONDS` | Duración refresh token | `2592000` |
| `SYNC_CURSOR_OVERLAP` | Margen de replay del cursor de sincronización | `100` (valor inicial ilustrativo; calibrar) |
| `IDEMPOTENCY_TTL_HOURS` | Retención de Idempotency-Key B2B | `24` |
| `LOG_LEVEL` | Nivel de logs | `debug` |

**Validación al arrancar:** un esquema de configuración debe rechazar el proceso si falta una variable obligatoria, si un número está fuera de rango, si la URL de producción no usa TLS, si `OTP_MODE=mock` en producción, si `ENCRYPTION_MODE=local` en producción o si se detectan claves locales en producción. También debe validar que `APP_TIMEZONE` sea exactamente `America/Managua` para este despliegue.

En producción las credenciales AWS se obtienen preferentemente mediante IAM Role/credenciales temporales del workload, no mediante access keys estáticas. Si el entorno obliga a inyectar secretos, se hace desde secret manager y con rotación.

### 3.6 Extensiones y migraciones

Extensiones requeridas:

- `postgis`: tipos espaciales, índices y operaciones geográficas.
- `pgcrypto`: funciones criptográficas de PostgreSQL disponibles para utilidades controladas. El cifrado de campos sensibles de negocio sigue realizándose en la capa NestJS con AES-256-GCM y KMS, no mediante SQL ad hoc.

Política:

1. Migraciones Prisma versionadas en Git.
2. Objetos no expresables por Prisma —PostGIS, índices GiST, extensiones, secuencia global, funciones y triggers— se declaran como SQL manual dentro de una migración versionada.
3. El pipeline despliega con `prisma migrate deploy`; no se usa `migrate dev` en producción.
4. Una migración aplicada no se edita. Las correcciones se agregan en una migración posterior.
5. Cada migración incluye un script SQL de reversa documentado. CI aplica la migración, comprueba los criterios y ejecuta la reversa contra una base de pruebas aislada.
6. Producción usa expandir/contraer: añadir estructuras compatibles, desplegar código compatible, migrar datos si procede y retirar estructuras antiguas en un despliegue posterior. Antes de cambios destructivos se genera y verifica respaldo. Si falla, se prefiere corrección hacia adelante cuando el rollback pueda perder datos.
7. El rol `app_migrator` ejecuta DDL. API y workers nunca ejecutan migraciones al arrancar.

La reversa documentada no implica que toda operación de datos sea semánticamente reversible. Las migraciones destructivas deben tener una estrategia de restauración de datos y aprobación explícita.

### 3.7 Seeds por entorno

| Tipo de datos | Desarrollo | Pruebas | Producción |
|---|---|---|---|
| Catálogos de marca/modelo, tipos, especialidades, departamentos/municipios | Dataset pequeño reproducible | Fixtures deterministas y aislados | Datos de referencia revisados, versionados e idempotentes |
| Números de emergencia | Solo datos ficticios marcados como tales o catálogo vacío | Fixtures no utilizables fuera de tests | Solo números confirmados por fuente oficial y verificados; no inventar ni mostrar pendientes |
| Talleres/proveedores | Datos sintéticos claramente identificados | Fábricas deterministas por test | Ningún taller ficticio; alta real y moderada |
| Usuarios, tokens, OTP | Usuarios de prueba y OTP simulado | Usuarios efímeros por suite | Datos reales; Twilio Verify |
| Campañas/pagos/comprobantes | Simulados, sin transferencias reales | Nunca contactar banco/proveedor | Flujos B2B reales con revisión manual |

Los seeds no se ejecutan en cada arranque de la API. Son tareas explícitas del pipeline o comandos controlados. Cada seed es idempotente y no sobrescribe datos operativos.

## 4. Modelo de datos por dominios

El inventario completo de campos, tipos PostgreSQL, constraints, índices y relaciones está en [`data-dictionary.md`](./data-dictionary.md). Esta sección fija las reglas transversales:

### 4.1 Identidad, roles y propiedad

Roles: `user`, `workshop_owner`, `provider_owner`, `admin`. Guards validan rol y propiedad. Un rol no concede acceso a recursos de otro propietario. Cuando la propiedad es indirecta, como una oferta perteneciente a un taller, la relación se resuelve y verifica en base de datos y servicio.

### 4.2 Tablas sync-ready

Las tablas de contenido propiedad del usuario que permiten edición desde el móvil se marcan `SYNC-READY` en el diccionario. En todas ellas:

- `id UUID` lo genera el cliente (UUID v7) antes de operar offline.
- `user_id UUID` o equivalente explícito de propietario está indexado y se usa en cada lectura/escritura privada.
- `created_at`, `updated_at`, `deleted_at` son `timestamptz` en UTC.
- `sync_version BIGINT` lo asigna únicamente un trigger PostgreSQL con una secuencia global. El cliente nunca lo envía ni lo calcula.
- Borrado lógico mediante `deleted_at`; no se elimina físicamente en el flujo ordinario.
- `sync/push` recibe `mutation_id` para idempotencia de la mutación; no usa `Idempotency-Key`.

Los registros operativos de autenticación, entrega y auditoría que contienen `user_id` por trazabilidad no se consideran contenido editable propiedad del usuario y no se descargan mediante `/sync/pull`. Su excepción y razón se documentan por tabla. **PENDIENTE DE APROBACIÓN:** confirmar que esta distinción satisface el alcance literal de “toda tabla que pertenezca a un usuario”; si se interpreta como cualquier tabla con FK `user_id`, deberán ampliarse las columnas sync-ready sin exponer secretos ni eventos técnicos al cliente.

### 4.3 Secuencia y cursor global

Se define una única secuencia PostgreSQL `sync_version_seq`. Un trigger `BEFORE INSERT OR UPDATE` en cada tabla sync-ready asigna `nextval('sync_version_seq')` a `sync_version` y controla `updated_at`. No se asigna desde NestJS ni desde el cliente. Los huecos de secuencia son normales.

Las secuencias no reflejan orden de commit: una transacción puede reservar una versión baja y confirmar después de otra con versión mayor. Por eso `/sync/pull` aplica un solapamiento configurable al rango consultado y entrega `next_cursor` para la siguiente lectura. El cliente aplica upsert idempotente por `id` y compara `sync_version`; volver a recibir una fila no duplica el efecto.

El tamaño exacto de `SYNC_CURSOR_OVERLAP` se calibra con concurrencia y duración de transacciones. El solapamiento es una mitigación, no una garantía matemática ante transacciones arbitrariamente largas: se deben limitar transacciones, monitorear antigüedad de transacciones y ejecutar reconciliaciones periódicas. Si se confirma que una transacción puede superar el margen, se incrementa el margen o se adopta un watermark de commits más estricto antes de liberar sincronización.

### 4.4 Idempotencia por tipo

| Caso | Mecanismo |
|---|---|
| Entidades sync-ready | UUID v7 de cliente + `mutation_id` en `/sync/push`; guardar resultado procesado para replay |
| Órdenes de pago B2B, comprobantes, contratación de planes y demás escrituras sin ID cliente | Cabecera `Idempotency-Key` obligatoria; persistencia por 24 horas; misma clave y mismo request devuelve la respuesta original; misma clave con payload distinto produce conflicto |
| Jobs BullMQ | `jobId` determinista/deduplicación cuando aplique y procesador idempotente; el estado persistente está en PostgreSQL |

### 4.5 Cifrado y campos sensibles

El cifrado de campos se ejecuta en la aplicación mediante envelope encryption:

1. NestJS solicita una data key a AWS KMS (`GenerateDataKey`) bajo la clave maestra del entorno.
2. La aplicación cifra el valor con AES-256-GCM usando nonce aleatorio único por cifrado y datos asociados que incluyan tabla, campo y registro.
3. Se persisten ciphertext, nonce, tag, data key cifrada y el identificador/versión de clave. La data key en claro se elimina de memoria tan pronto como termina la operación.
4. En lectura, KMS descifra la data key cifrada y la aplicación verifica el tag GCM antes de entregar el valor autorizado.
5. La rotación conserva la referencia a la versión usada por cada valor y permite descifrar datos antiguos durante el proceso de re-cifrado.

Los índices ciegos HMAC se calculan en la aplicación con una clave separada por propósito (no reutilizar la clave AES-GCM). En producción la clave de índice debe ser una clave AWS KMS de tipo HMAC_256 y el rol de ejecución requiere `kms:GenerateMac`; `AWS_KMS_BLIND_INDEX_KEY_ARN` identifica esa clave. Guardan HMAC del valor normalizado y el identificador KMS usado para poder identificar la clave al operar/rotar. Permiten igualdad/búsqueda exacta sin consultar el texto claro. No permiten búsquedas parciales ni ordenamiento; esa limitación se acepta para números de póliza/placa.

En desarrollo/pruebas se permite una clave local por variables de entorno. En producción es obligatorio `ENCRYPTION_MODE=kms`; el arranque falla si se detecta una clave local. Los archivos de S3 se cifran en reposo con SSE-KMS además del cifrado de transporte.

Campos previstos para cifrado: teléfono de cuenta usado para OTP, email si se recopila, IP y User-Agent capturados en ConsentLog (si están disponibles), token FCM, números de póliza, números de documento cuando se almacenen, placa/VIN cuando proceda, teléfonos de contactos privados/emergencia, teléfonos/WhatsApp del directorio (aunque sean públicos por consentimiento) y referencias bancarias/comprobantes textuales. Para los teléfonos publicados por un negocio, NestJS descifra solo después de validar que la ficha está publicada y que el consentimiento de publicación está vigente; el valor en claro no se persiste ni se registra en logs.

### 4.6 Catálogos, precios, anuncios y reseñas

- Catálogos de referencia son de solo lectura para clientes normales; solo administración/seed puede modificarlos.
- `ServiceOffering` debe tener exactamente un propietario: `workshop_id XOR assistance_provider_id`. Se impone con `CHECK` y claves foráneas compuestas para comprobar que el `user_id` coincide con el dueño.
- `min_price_usd` y `max_price_usd` son decimales, no `float`; mínimo positivo y menor o igual al máximo.
- Para precios de servicios, la API siempre incluye el texto obligatorio de precio estimado. El NIO es equivalente informativo y debe incluir tasa y fecha.
- Las campañas pagadas habilitan `patrocinado: true` únicamente durante su vigencia y estado aprobado/pagado. Las métricas publicitarias no modifican la puntuación, contenido ni orden orgánico de reseñas.
- Los precios B2B de planes publicitarios son cargos a negocios, no precios de servicios al conductor. **PENDIENTE DE APROBACIÓN:** confirmar si esos precios B2B también deben llevar el texto legal de precio estimado, que semánticamente habla de pago directo al taller/proveedor.

## 5. Redis, S3 y colas

### 5.1 Redis: permitido y prohibido

Redis contiene únicamente estado reconstruible o temporal:

- Caché de catálogos públicos, búsquedas frecuentes y configuración de lectura con TTL e invalidación.
- Contadores/ventanas de rate limit para OTP, login, refresh, búsquedas y endpoints sensibles. Las rutas autenticadas usan identidad usuario+dispositivo; OTP aplica además un identificador HMAC del teléfono, nunca un SHA-256 sin clave.
- Estructuras internas de BullMQ: jobs, locks, delayed jobs y estados transitorios.
- Locks efímeros de coordinación, siempre con TTL y sin sustituir constraints/transacciones PostgreSQL.

Redis **no** contiene la única copia de usuarios, documentos, pólizas, pagos, consentimiento, reseñas, solicitudes de auxilio ni auditoría. Si Redis se pierde, la API puede reconstruir cachés y reprogramar trabajos pendientes a partir de PostgreSQL. Los resultados de idempotencia de operaciones B2B se guardan en PostgreSQL, no solo en Redis.

### 5.2 S3: buckets, prefijos y nombres

Se usa un bucket privado separado por entorno. Esquema lógico de prefijos:

| Prefijo | Contenido | Acceso |
|---|---|---|
| `users/{user_id}/vehicles/{vehicle_id}/documents/{random_id}` | Pólizas, circulación, revisión y licencia | Solo propietario/admin autorizado mediante URL firmada |
| `users/{user_id}/vehicles/{vehicle_id}/photos/{random_id}` | Fotografías privadas de vehículos | Solo propietario mediante URL firmada; key generada por API |
| `workshops/{workshop_id}/photos/{random_id}` | Fotografías del taller | URL firmada tras verificar que la imagen está publicada; no exponer bucket |
| `providers/{provider_id}/photos/{random_id}` | Fotografías del proveedor | Igual que fotos de taller |
| `billing/{payment_id}/proofs/{random_id}` | Comprobantes de transferencia B2B | Propietario y administración autorizada |
| `exports/{user_id}/{random_id}` | Exportación de datos del usuario | Solo propietario; descarga temporal |
| `staging/{random_id}` | Subidas aún no finalizadas | API; nunca listado por cliente |

`random_id` debe contener entropía criptográfica suficiente y no derivarse del nombre del archivo, placa, teléfono ni número de póliza. El nombre original se guarda como metadato saneado solo si es necesario. No se aceptan rutas completas desde el cliente.

**Vigencia inicial de URLs firmadas:** PUT de subida 5 minutos; GET de descarga 10 minutos. Las vigencias son configurables por entorno y se reducen cuando el riesgo lo requiera. Las URL solo habilitan método/objeto/headers esperados. La expiración no revoca una URL antes de su tiempo; por ello no se loguea ni comparte.

La API valida tamaño, extensión permitida, MIME declarado y firma real del archivo/checksum. S3 `HEAD` verifica tamaño y metadatos antes de asociar el objeto. No se reutilizan keys para nuevas cargas. Debido a que una URL PUT puede reutilizarse hasta expirar, las cargas se reciben en staging y se finalizan a una key final distinta e inmutable, o se aplica una condición de creación única compatible con el mecanismo de upload elegido.

**Ciclo de vida:**

- Versioning y cifrado SSE-KMS habilitados en buckets privados; acceso público bloqueado.
- Los objetos finales de documentos y comprobantes no se eliminan por una regla genérica de expiración.
- Los objetos temporales/orphan pasan primero por reconciliación en base de datos, quedan registrados/auditados y solo se purgan al terminar el flujo de retención/eliminación aprobado.
- La eliminación de cuenta debe coordinar registro lógico, exportación solicitada, retención exigida y purga de objetos conforme a la política aprobada. Cualquier plazo legal debe **validarse con abogado local**.
- Las fotos retiradas pueden quedar no publicadas y conservarse según la política de retención; no se borran físicamente fuera del flujo definido.

### 5.3 Colas BullMQ

| Cola lógica | Evento que la origina | Fuente de verdad / reconciliación |
|---|---|---|
| `document-reminders` | Crear/actualizar documento con fecha de vencimiento; reprogramar recordatorios escalonados | `VehicleDocument`, `Reminder`, `NotificationPreference` |
| `ad-campaigns` | Activación, inicio/fin y agregación de campañas | `AdCampaign`, `AdPlan`, `AdMetric`, `Payment` |
| `provider-notifications` | Nueva solicitud de auxilio elegible para proveedores | `AssistanceRequest`, preferencias/estado del proveedor |
| `push-notifications` | Enviar FCM tras evento de negocio | `NotificationLog`, `DeviceToken` |
| `storage-cleanup` | Reconciliar cargas incompletas y objetos no asociados | registros de carga y referencias S3 en PostgreSQL |
| `maintenance` | Tareas de mantenimiento, retención, expiración de idempotencia y limpieza lógica | PostgreSQL; cada acción auditada |

Reglas comunes:

- Los jobs contienen identificadores y datos mínimos; no se colocan números de póliza, tokens JWT, OTP ni documentos completos en el payload.
- Reintentos con backoff exponencial y jitter, con número máximo de intentos por tipo de operación. Errores permanentes se mueven a estado fallido/DLQ lógica y generan alerta.
- Cada procesador debe poder ejecutarse varias veces sin duplicar el efecto: consultar estado actual, aplicar transición condicional y usar identificador determinista/deduplicación cuando corresponda.
- No se asume entrega exactly-once. Se diseña para al menos una ejecución y efectos idempotentes.
- Una caída de Redis no pierde el estado del negocio: PostgreSQL permite reconstruir jobs o reprogramarlos.

Referencias: [BullMQ retries/backoff](https://docs.bullmq.io/guide/retrying-failing-jobs) y [BullMQ idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs).

## 6. Integraciones externas

### 6.1 Twilio Verify

Twilio Verify entrega y verifica OTP por SMS y WhatsApp. El backend solicita la verificación y valida el código; nunca almacena OTP en claro ni lo escribe en logs. WhatsApp requiere habilitación/configuración del sender y su disponibilidad se confirma para el país/cuenta antes del despliegue. En dev/test se usa proveedor simulado determinista; no se envían mensajes reales.

Twilio Verify se usa para autenticación OTP, no como servicio asumido para mensajes generales de recordatorios o campañas. Los avisos de aplicación se envían mediante FCM; un canal outbound WhatsApp para notificaciones requeriría decisión e integración explícita separada.

Referencia: [Twilio Verify WhatsApp](https://www.twilio.com/docs/verify/whatsapp) y [Verification Channels](https://www.twilio.com/docs/verify/authentication-channels).

### 6.2 Firebase Cloud Messaging

FCM se invoca únicamente desde el backend con Firebase Admin SDK o HTTP v1. Las credenciales de servicio quedan en el entorno servidor. El token de registro del dispositivo se trata como secreto operativo, se guarda cifrado/hash según el diccionario y se elimina/desactiva al invalidarse. FCM es un transporte: `NotificationLog` registra el resultado operativo.

Referencia: [FCM server environment](https://firebase.google.com/docs/cloud-messaging/server-environment).

### 6.3 Precios y tipo de cambio

La aplicación almacena precios de servicio en USD como valor canónico. El equivalente NIO se calcula con una tasa explícita, fecha de vigencia y fuente; no se codifica una tasa fija en el cliente. Los valores de dinero usan `numeric`, nunca coma flotante binaria.

**PENDIENTE DE APROBACIÓN:** escoger la fuente oficial/operativa del tipo de cambio, la frecuencia de actualización y si se conserva una tasa snapshot al publicar cada precio o se presenta la tasa vigente al consultar. Hasta esa decisión no se inventan montos en NIO.

## 7. Entornos

| Aspecto | Desarrollo | Pruebas | Producción |
|---|---|---|---|
| PostgreSQL | Instancia local Docker; datos descartables | Contenedor Testcontainers aislado por suite/worker | Instancia administrada dedicada |
| PostGIS/pgcrypto | Mismas extensiones que producción | Mismas versiones principales que producción | Versiones fijadas y monitoreadas |
| Redis | Local Docker | Contenedor aislado; namespace/DB separado | Servicio administrado con TLS y autenticación |
| S3 | Bucket dev aislado o emulador compatible solo si cubre firmas reales | Bucket temporal/test con limpieza controlada | Bucket privado propio de producción |
| KMS | `ENCRYPTION_MODE=local` con clave de prueba | Claves de prueba aisladas; nunca usar datos reales | `ENCRYPTION_MODE=kms`, IAM mínimo, key ARN propia |
| OTP | `OTP_MODE=mock`; códigos predecibles solo en local | Mock determinista; tests de contrato sin envío real | Twilio Verify SMS/WhatsApp habilitado |
| FCM | Proyecto Firebase dev o adapter mock | Mock; pruebas de contrato sin push real | Proyecto Firebase producción |
| JWT | Claves locales de desarrollo | Secretos efímeros por suite | Secretos/keys gestionadas fuera de Git |
| Datos | Ficticios | Sintéticos y reseteables | Datos reales con acceso auditado |
| Logs | Verbosos, datos sensibles redactados | Captura de errores para asserts, sin secretos | JSON estructurado, redacción y retención definida |

Los entornos no comparten bases de datos, buckets, Redis, Twilio Verify Service, proyectos Firebase ni claves KMS. Producción nunca acepta credenciales de dev/test. `NODE_ENV=production` fuerza OTP real, TLS, KMS e IAM de producción.

## 8. Respaldo y recuperación

### 8.1 Política inicial propuesta

Objetivos iniciales sujetos al costo del proveedor y aprobación operativa:

| Recurso | Respaldo/retención propuesta | Observaciones |
|---|---|---|
| PostgreSQL | PITR con archivado continuo de WAL + snapshot/base backup diario; retención de 35 días | El backup incluye estructura, datos, índices y objetos PostGIS; secretos y claves KMS se gestionan por separado |
| Copia mensual PostgreSQL | Retención de 12 meses | En cuenta/proyecto de respaldo separado; cifrada |
| S3 | Versioning habilitado; replicación/copia a otra cuenta o región según presupuesto; inventario diario | No se configura expiración destructiva de documentos activos |
| Redis | No es respaldo de fuente de verdad; persistencia/snapshot opcional para acelerar recuperación | BullMQ se reconstruye desde PostgreSQL cuando aplique |
| Claves KMS | Rotación habilitada donde corresponda y conservación de key versions | No destruir una KMS key mientras existan valores cifrados con ella |

Objetivos propuestos: **RPO ≤ 15 minutos** y **RTO ≤ 4 horas** para PostgreSQL. Son objetivos de diseño, no garantías hasta verificar que el proveedor, plan y costo los soportan.

### 8.2 Prueba de restauración

- Restaurar mensualmente una copia en un entorno aislado, nunca sobre producción.
- Ejecutar PITR a un instante elegido y comprobar consistencia de tablas, constraints, secuencia global, triggers, grants y extensiones.
- Ejecutar consultas PostGIS representativas y validar índices espaciales.
- Verificar que se pueden descifrar registros de prueba con las versiones KMS preservadas; no exportar claves en claro.
- Verificar accesibilidad/integridad de objetos S3 y asociación con filas restauradas.
- Levantar API en modo de smoke test, validar login simulado, lectura de catálogo, consulta del directorio y un flujo de exportación sintético.
- Medir tiempo real de recuperación, registrar evidencia, fallos y acciones correctivas. La prueba se considera incompleta si solo se comprueba que el archivo de backup existe.

### 8.3 Eliminación de cuenta y retención

La eliminación comienza con una solicitud autenticada, verificación adicional y registro de auditoría. Se bloquean nuevas sesiones, se revocan refresh tokens y se desactivan dispositivos. Se prepara exportación cuando el usuario la solicite. Los datos de negocio se marcan lógicamente; archivos y referencias pasan a una cola de retención/purga con control de propietario y trazabilidad. Antes de purgar se aplican obligaciones de conservación que hayan sido validadas con abogado local. No existe borrado físico inmediato ni una regla automática que ignore este flujo.

## 9. Observabilidad y operación

Toda solicitud HTTP tiene `request_id` propagado a logs y auditoría. Logs estructurados redactan OTP, JWT, URLs firmadas, tokens FCM, claves, números de póliza y datos cifrados. Métricas mínimas:

- Latencia/errores por ruta, rate-limit hits y errores de validación.
- Conexiones PostgreSQL, pool waits/timeouts, duración y antigüedad de transacciones.
- Cache hit ratio y disponibilidad Redis.
- Jobs pendientes, retraso, reintentos, fallidos y edad del job más antiguo.
- Firmas S3 creadas/expiradas, cargas huérfanas y fallos de verificación.
- OTP enviados/verificados/fallidos, sin registrar códigos.
- Push enviados/fallidos y tokens FCM inválidos.
- Uso de claves KMS, errores de decrypt, versiones por campo y rotaciones pendientes.
- Cursor sync, volumen de replay/duplicados y transacciones que excedan el umbral operativo.

Errores API siguen `{ code, message, details, request_id }`, mensajes en español y respuestas JSON. Paginación limitada a 50. Endpoints sensibles tienen rate limit por usuario, IP y/o dispositivo según riesgo.

## 10. Secuencia de arranque de un desarrollador

1. Obtener variables de entorno locales desde `.env.example` sin secretos reales.
2. Levantar PostgreSQL 16 con PostGIS/pgcrypto y Redis mediante Docker.
3. Crear roles locales de migración/runtime con contraseñas de desarrollo.
4. Instalar dependencias y validar configuración; el proceso debe fallar si falta una variable requerida.
5. Ejecutar migraciones versionadas en una base vacía y comprobar extensiones/triggers.
6. Ejecutar seeds locales idempotentes.
7. Arrancar NestJS con `OTP_MODE=mock` y `ENCRYPTION_MODE=local`.
8. Consultar `/api/v1` y Swagger cuando B0/B1 creen el bootstrap de la API. Esta fase no crea el módulo HTTP ni endpoints.
9. Ejecutar pruebas Jest/Supertest/Testcontainers.

Los comandos concretos se definirán en B0 al crear el repositorio; no se inventan aquí scripts que todavía no existen.

## 11. Pendientes que requieren aprobación antes de implementarse

1. Confirmar el alcance de `sync-ready` para tablas con FK `user_id` que son técnicas/operativas (tokens, logs y registros del protocolo).
2. Definir fuente, frecuencia y snapshot de tasa USD/NIO.
3. Confirmar tratamiento del texto obligatorio de precio estimado en respuestas de precios de planes publicitarios B2B.
4. Calibrar `SYNC_CURSOR_OVERLAP` y límites de transacción tras pruebas de concurrencia; el ejemplo `100` no es un valor aprobado.
5. Confirmar proveedor/plan de PostgreSQL y el presupuesto de conexiones antes de fijar PgBouncer y pools de producción.
6. Confirmar límites de tamaño/tipos MIME de archivos, antivirus/escaneo y retención documental.
7. Validar con abogado local las políticas de consentimiento, retención, exportación y eliminación bajo Ley 787; no se atribuyen artículos ni plazos legales en este documento.
8. Verificar disponibilidad y configuración de Twilio Verify WhatsApp para la cuenta/destino antes de producción.
9. Definir fuente oficial y proceso de verificación de números de emergencia; el catálogo no se publica hasta su verificación.

## 12. Referencias técnicas

- [Prisma ORM — Raw queries](https://www.prisma.io/docs/orm/reference/raw-queries)
- [Prisma ORM — PgBouncer](https://docs.prisma.io/docs/orm/v7/prisma-client/setup-and-configuration/databases-connections/pgbouncer)
- [PostGIS — Spatial indexes](https://postgis.net/documentation/faq/spatial-indexes/)
- [PostGIS — ST_DWithin](https://postgis.net/documentation/tips/st-dwithin/)
- [AWS S3 — Presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
- [AWS KMS — Data keys](https://docs.aws.amazon.com/kms/latest/developerguide/data-keys.html)
- [BullMQ — Retries](https://docs.bullmq.io/guide/retrying-failing-jobs)
- [BullMQ — Idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs)
- [Twilio Verify — WhatsApp](https://www.twilio.com/docs/verify/whatsapp)
- [Firebase Cloud Messaging — Server environment](https://firebase.google.com/docs/cloud-messaging/server-environment)
- [PostgreSQL — pgcrypto](https://www.postgresql.org/docs/current/pgcrypto.html)


## Implementación fundacional B0

- Las rutas de infraestructura `GET /health` y Swagger `/docs` viven en raíz; solo rutas de negocio usan `/api/v1`.
- `GET /health` verifica PostgreSQL mediante `SELECT 1` y Redis mediante `PING`.
- `app_runtime` no tiene privilegios DDL ni recibe la URL/contraseña de `app_migrator`. Las migraciones se ejecutan explícitamente con `prisma migrate deploy` desde un job separado.
- La secuencia `sync_version_seq` se crea con `CACHE 1`; el trigger asigna `sync_version` y `updated_at` y preserva `created_at`. Toda tabla sync-ready futura debe incluir `user_id` indexado, UUID v7 cliente y trigger; véase `docs/sync-ready-template.md`.
- Los seeds de B0 son vacíos y separados por entorno: no se inventan talleres, catálogos oficiales ni teléfonos de emergencia.
- La cobertura del 70% se activa para lógica de negocio por módulo conforme existan casos funcionales; B0 mantiene cobertura informativa de infraestructura.

## Extensión B3 — documentos privados y pólizas

`vehicle_documents` e `insurance_policies` son tablas sync-ready: `id` UUID v7 del cliente, `user_id` indexado, timestamps UTC, `deleted_at`, y `sync_version` asignado por el trigger global `assign_sync_metadata()`. La relación vehículo/propietario se protege con FK compuesta `(vehicle_id,user_id)`. Los triggers adicionales impiden asociar una póliza anterior o documento de póliza de otro dueño/vehículo.

`insurers` es un catálogo de solo lectura, con `catalog_versions` y ETag. El catálogo no se rellena con compañías inventadas: solo se habilitan entradas tras revisión de fuentes/operación.

### Archivos de documentos

- Tipos admitidos: PDF, JPEG/JPG, PNG y HEIC. Límite duro: 10 MiB por archivo.
- El backend genera object keys criptográficamente aleatorias; nunca acepta rutas ni keys propuestas por el cliente.
- El cliente registra el documento como `pendiente_subida`, solicita una URL PUT firmada (5 minutos), sube directamente a S3 y confirma. La API verifica `HEAD` (tamaño/MIME) y firma mágica de bytes iniciales (PDF/JPEG/PNG/HEIC) antes de establecer `disponible`.
- Descargas mediante URL GET firmada de 10 minutos. Las keys nunca se devuelven al cliente; bucket privado, SSE-KMS y TLS.
- El archivo local no se elimina hasta que la confirmación del backend devuelva `disponible`.
- En dev/test el adaptador de almacenamiento simulado permite probar el flujo, pero no verifica bytes reales. Producción rechaza confirmar si no puede inspeccionar el objeto S3 real.

### Cifrado vinculado a fila (AAD v2)

Se extiende `FieldCryptoService.encrypt/decrypt` con contexto opcional de fila (`user_id`, `record_id`). Para AAD v2 esos valores se incluyen tanto en el EncryptionContext de KMS como en el AAD de AES-256-GCM. Los nuevos números de póliza y teléfonos de siniestros usan AAD v2. La migración B3 agrega `plate_aad_version` y `vin_aad_version`: registros existentes permanecen en v1 y siguen descifrándose; nuevas escrituras de placa/VIN usan v2. Así la migración es compatible y no requiere re-cifrado inmediato de registros antiguos. La rotación gradual de datos v1 se mantiene como tarea operativa.

`DOCUMENT_EXPIRING_SOON_DAYS` define el umbral de vencimiento (default 30 días, rango 1–365). La fecha actual se calcula en `America/Managua`; fechas `DATE` se transportan como `YYYY-MM-DD` sin conversión de zona horaria.

**Variable B3:** `DOCUMENT_EXPIRING_SOON_DAYS` (default `30`, rango `1..365`) controla el umbral de `por_vencer`; se interpreta usando `America/Managua`.


## Extensión B4 — recordatorios, BullMQ y FCM

PostgreSQL conserva los recordatorios y su estado. BullMQ usa Redis como coordinador de trabajos, no como fuente de verdad. Un dispatcher repetido cada minuto toma recordatorios vencidos, crea jobs de ID estable y el worker reclama el registro mediante una transición condicional `scheduled -> processing`. El worker registra los resultados en `notification_logs`, aplica reintentos exponenciales y limpia tokens FCM que el proveedor marque como inválidos.

Las fechas civiles se calculan en `America/Managua`; la hora inicial es 09:00. `GET /reminders/schedule` entrega una proyección de 90 días para notificaciones locales offline. La configuración Firebase se proporciona mediante credenciales Base64 en variables de entorno, nunca en el repositorio.

## Implementación B6 — Directorio de talleres

B6 agrega `workshops`, `workshop_specialties`, `workshop_photos`, `service_offerings`, eventos de contacto y el ancla relacional `assistance_providers`. La búsqueda de talleres activos usa `geography(Point,4326)`, GiST y `ST_DWithin` para filtrar radio antes de calcular distancia; texto usa un TSVECTOR generado con GIN. El objetivo de latencia a 5 km/5 000 registros es un objetivo de prueba y aún no está medido.

Los contactos comerciales (teléfono, WhatsApp, correo) se guardan cifrados con AAD v2. La consulta de proximidad devuelve indicadores de disponibilidad, no descifra contactos en bloque; el usuario solicita el contacto al abrir la acción del taller activo. Las fotografías se sirven con URLs S3 firmadas tras verificación del objeto.

El horario semanal es JSONB y se calcula en `America/Managua`; el filtro SQL `workshop_is_open_now` admite turnos nocturnos. Redis mantiene un caché temporal de búsqueda de 60 segundos con invalidación por versión; la API informa al móvil una política de caché offline limitada a 50 resultados y siete días (`fetched_at`, `cache_ttl_seconds`).

La oferta comercial tiene un CHECK XOR en PostgreSQL para garantizar un dueño exacto (`workshop_id` o `assistance_provider_id`) y FKs compuestas con `user_id`. La moneda editable es USD, los precios se etiquetan como estimados y se señalan desactualizados después de 90 días. B9 conecta campañas activas y pagadas con la búsqueda B6, manteniendo el orden orgánico relativo. El diseño y los endpoints se documentan en [B9](b9-advertising.md).


## Implementación B7 — Asistencia en carretera

B7 completa `assistance_providers` con contactos cifrados, disponibilidad, indicador 24 horas y `coverage_area geometry(MultiPolygon,4326)` indexado con GiST. La consulta valida cobertura con `ST_Covers`, limita candidatos mediante `ST_DWithin` sobre `base_location::geography` y ordena disponibilidad, servicio 24 horas y distancia. La ficha requiere revisión administrativa antes de publicarse; cambios de contacto, localización, cobertura o datos territoriales revocan la verificación.

Las solicitudes `assistance_requests` se mantienen en el contrato B5S del conductor; el directorio de proveedores queda excluido del sync móvil y se entrega como proyección temporal en el paquete offline de emergencia (TTL móvil 7 días y límite estricto de 99.999 bytes (<100 KB)). El móvil conserva `pending_envio` localmente; el servidor persiste `created` al recibir el UUID v7.

La solicitud se notifica después del commit mediante BullMQ y una interfaz `AssistanceNotificationAdapter`, con modo `mock` para desarrollo/test y Twilio para SMS/WhatsApp. Las transiciones del proveedor se realizan con enlaces aleatorios de un solo uso: se almacena SHA-256, hay vencimiento, confirmación POST y bloqueo transaccional de solicitud/token. El historial queda en `assistance_request_events`. No existe cobro al conductor; los precios públicos son estimaciones con el texto legal definido en B6. Los números de emergencia solo salen del catálogo oficial con verificación; no se inventa un teléfono general si la tabla aún no tiene uno verificado.
