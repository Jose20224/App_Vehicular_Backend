# Registro de decisiones de arquitectura

**Producto:** aplicación móvil de gestión vehicular y asistencia en carretera para Nicaragua  
**Versión:** 0.1.0  
**Fecha de creación:** 2026-11-03  
**Estado:** registro inicial para revisión.  

Este registro conserva decisiones explícitamente confirmadas y propuestas que requieren aprobación. Las decisiones aceptadas no se cambian durante una fase sin autorización del propietario del proyecto y una nueva entrada que explique el motivo.

## Decisiones aceptadas

### D-001 — Stack backend fijo

- **Estado:** Aceptada.
- **Decisión:** NestJS + TypeScript; PostgreSQL 16 + PostGIS; Prisma con SQL crudo parametrizado para geoespacial; Redis + BullMQ; JWT propio access/refresh; Twilio Verify para OTP SMS/WhatsApp; AWS S3 con URLs firmadas; FCM; OpenAPI/Swagger; Jest + Supertest + Testcontainers; Docker y GitHub Actions.
- **Consecuencia:** no se sustituuyen tecnologías por alternativas durante las fases de implementación sin aprobación expresa.

### D-002 — La API es la única puerta de entrada a datos

- **Estado:** Aceptada.
- **Decisión:** el móvil se comunica con `/api/v1` por HTTPS. Nunca se conecta directamente a PostgreSQL ni a Redis; el acceso a S3 solo se permite con URL firmada de alcance y duración limitados.
- **Consecuencia:** autenticación, validación, guards, propiedad, rate limiting, auditoría y reglas se ejecutan en NestJS.

### D-003 — UTC y zona operativa de Nicaragua

- **Estado:** Aceptada.
- **Decisión:** instantes persistidos como UTC (`timestamptz`); reglas de calendario y presentación usan `America/Managua`.
- **Consecuencia:** no se guardan fechas/hora de negocio como strings locales sin zona. Los vencimientos civiles usan `date` cuando corresponda.

### D-004 — UUID v7 del cliente en datos sync-ready

- **Estado:** Aceptada.
- **Decisión:** toda entidad sync-ready usa `id UUID` generado por el cliente, permitiendo crear registros offline.
- **Consecuencia:** la API conserva el ID del cliente, valida el recurso y filtra por dueño. El ID nunca se sustituye al sincronizar.

### D-005 — `sync_version` global asignado por trigger PostgreSQL

- **Estado:** Aceptada.
- **Decisión:** una secuencia PostgreSQL global es compartida por las tablas sync-ready; un trigger en la base asigna `sync_version` en cada insert/update. La aplicación y el cliente no pueden asignarlo.
- **Consecuencia:** puede haber huecos; se conserva `BIGINT`; la secuencia no se reinicia por rollback ordinario.

### D-006 — Cursor incremental con solapamiento

- **Estado:** Aceptada en principio; tamaño por calibrar.
- **Decisión:** `/sync/pull` devuelve `next_cursor` considerando un pequeño margen de solapamiento porque las transacciones concurrentes pueden confirmar fuera de orden. El cliente aplica upsert idempotente; re-aplicar cambios no duplica efectos.
- **Consecuencia:** el margen se configura y calibra con pruebas de concurrencia. Se limitan/monitorizan transacciones largas. Un margen fijo no garantiza por sí solo capturar una transacción que confirme arbitrariamente tarde; si las pruebas evidencian ese escenario, se deberá fortalecer el watermark antes de producción.

### D-007 — Idempotencia diferenciada por tipo de escritura

- **Estado:** Aceptada.
- **Decisión:**
  - Entidades sync-ready: UUID v7 cliente + `mutation_id` en `/sync/push`; sin cabecera `Idempotency-Key`.
  - Operaciones sin ID de cliente —órdenes de pago B2B, comprobantes, contratación de planes—: `Idempotency-Key` obligatoria, persistida durante 24 horas. Repetición con mismo contenido devuelve la respuesta original; reutilización con distinto contenido genera conflicto.
- **Consecuencia:** los registros de replay B2B se conservan en PostgreSQL; Redis no es el único almacén de idempotencia.

### D-008 — Envelope encryption con AWS KMS

- **Estado:** Aceptada.
- **Decisión:** una clave maestra en AWS KMS protege claves de datos AES-256-GCM. Cada valor cifrado registra el identificador/versión de clave utilizada. En dev/test se permite clave local por entorno; en producción está prohibido.
- **Consecuencia:** claves de datos en claro viven solo el tiempo necesario en memoria; se conservan metadata suficiente para descifrar datos antiguos y rotar. Producción arranca solo con modo KMS.

### D-009 — Índices ciegos HMAC para búsquedas sensibles

- **Estado:** Aceptada.
- **Decisión:** cuando se requiera igualdad/búsqueda exacta de un campo cifrado —por ejemplo número de póliza— se utiliza índice HMAC, no descifrado masivo de filas.
- **Consecuencia:** clave HMAC separada de la clave AES; almacenar versión de clave; no soporta búsquedas parciales ni ordenamientos.

### D-010 — Roles PostgreSQL separados

- **Estado:** Aceptada.
- **Decisión:** `app_migrator` ejecuta DDL/migraciones; `app_runtime` ejecuta únicamente DML mínimo. SSL obligatorio en producción.
- **Consecuencia:** API/workers no tienen permisos DDL ni credenciales del rol de migración. La URL de migración es directa, separada de la URL runtime/pooler.

### D-011 — Migraciones versionadas y reversas probadas

- **Estado:** Aceptada.
- **Decisión:** migraciones versionadas, ejecutadas con `prisma migrate deploy`, nunca editadas una vez aplicadas. Cada una tiene script SQL de reversa documentado y probado en CI contra BD de pruebas. Producción usa expandir/contraer, respaldo previo y corrección hacia adelante cuando un rollback pueda perder datos.
- **Consecuencia:** PostGIS, extensiones, secuencias y triggers pueden requerir SQL manual dentro de la migración Prisma.

### D-012 — PostgreSQL fuente de verdad; Redis reconstruible

- **Estado:** Aceptada.
- **Decisión:** PostgreSQL conserva datos y estado de negocio. Redis se reserva para caché, rate limiting y BullMQ; nada crítico existe exclusivamente en Redis.
- **Consecuencia:** los jobs son idempotentes y reconstruibles; la pérdida de Redis no causa pérdida de documentos, pagos ni solicitudes.

### D-013 — Archivos privados con URLs firmadas

- **Estado:** Aceptada.
- **Decisión:** S3 usa buckets privados y claves aleatorias no predecibles. El backend emite URLs firmadas de carga/descarga. Valores iniciales: PUT 5 minutos y GET 10 minutos.
- **Consecuencia:** el cliente no elige keys; el backend valida objeto, tamaño, tipo y checksum antes de asociarlo a una entidad. Los documentos finales no tienen regla genérica de borrado automático.

### D-014 — Aplicación gratuita y monetización B2B

- **Estado:** Aceptada.
- **Decisión:** no existen pagos ni suscripciones de usuario conductor. Solo talleres/proveedores pagan publicidad mediante flujo B2B manual al inicio.
- **Consecuencia:** `AdPlan`, `AdCampaign`, `Payment`, `Invoice` y `PaymentProof` se limitan a anunciantes. Toda publicidad pagada publicada se identifica con `patrocinado: true`. No se manipulan ratings ni reseñas.

### D-015 — Precios estimados de servicios

- **Estado:** Aceptada.
- **Decisión:** los proveedores publican rango mínimo/máximo estimado. Toda respuesta API que presente precio de servicio incluye literalmente: “Precio estimado. El pago se realiza directamente al taller o al proveedor cuando se presta el servicio.”
- **Consecuencia:** USD es moneda canónica y NIO equivalente informativo. La conversión incluye tasa/fecha. Los detalles del servicio se aclaran mediante llamada/WhatsApp al negocio/proveedor.

### D-016 — XOR obligatorio en ServiceOffering

- **Estado:** Aceptada.
- **Decisión:** una oferta pertenece exactamente a un taller o a un proveedor, nunca a ambos ni a ninguno.
- **Consecuencia:** `CHECK` XOR en PostgreSQL y FK compuestas `(id,user_id)` para verificar que el usuario es dueño real del negocio.

### D-017 — Dirección textual obligatoria en solicitudes de auxilio

- **Estado:** Aceptada.
- **Decisión:** `AssistanceRequest.address_reference_text` es obligatorio y no vacío incluso cuando existen coordenadas GPS.
- **Consecuencia:** el backend rechaza solicitudes sin referencia textual; no se sustituye por coordenadas solas.

### D-018 — Catálogos de emergencia no se inventan

- **Estado:** Aceptada.
- **Decisión:** números de emergencia solo se publican después de verificación con fuente oficial/primaria. No se inventan teléfonos, artículos legales ni cifras.
- **Consecuencia:** catálogo puede permanecer vacío o pendiente de verificación hasta disponer de evidencia.

### D-019 — Consentimiento, exportación y eliminación

- **Estado:** Aceptada como requisito de producto; detalles legales pendientes.
- **Decisión:** registrar consentimiento por tipo y versión; cifrar datos sensibles; soportar exportación y flujo de eliminación de cuenta; no eliminar físicamente al instante.
- **Consecuencia:** alcance, retención y excepciones legales de Ley 787 se deben **validar con abogado local**. Este registro no interpreta artículos ni plazos.

## Decisiones propuestas / pendientes de aprobación

### P-001 — Alcance exacto de SYNC-READY en tablas técnicas con `user_id`

- **Estado:** Pendiente de aprobación.
- **Propuesta:** `SYNC-READY` cubre contenido editable del usuario y del dueño de negocio. `RefreshToken`, `NotificationLog`, `SyncDevice` y `ProcessedMutation` son registros técnicos del servidor, aunque contengan FK `user_id`, y no se replican en `/sync/pull`.
- **Motivo:** evitar exponer secretos/tokens y metadatos internos del protocolo como datos del cliente.
- **Riesgo/impacto:** si la regla se interpreta literalmente como toda tabla con FK `user_id`, esas tablas requieren columnas de sincronización adicionales o una clasificación formal como información operativa no propiedad del usuario. Ver `data-dictionary.md`.

### P-002 — Fuente y frecuencia del tipo de cambio USD/NIO

- **Estado:** Pendiente de aprobación.
- **Propuesta:** tabla `exchange_rates` mantiene tasas aprobadas con fuente, `effective_at` y `captured_at`; la API informa tasa y fecha junto al NIO equivalente.
- **Pendiente:** fuente de referencia, responsable de actualización, frecuencia y si un precio de servicio conserva snapshot al publicarse o usa tasa vigente al consultarse.

### P-003 — Texto obligatorio de precio en planes publicitarios B2B

- **Estado:** Pendiente de aprobación.
- **Propuesta:** el texto obligatorio de precio estimado se aplica a los precios de servicios mostrados a conductores. Los planes publicitarios se etiquetan como `precio_publicitario_b2b` porque son cargos a negocios y no pago de servicio por parte del conductor.
- **Pendiente:** confirmar si la regla literal “toda respuesta de API con precios” también debe colocar ese texto en respuestas de precios B2B, aunque el mensaje diga que el pago se hace directamente al taller/proveedor.

### P-004 — Pool PostgreSQL y PgBouncer de producción

- **Estado:** Pendiente de infraestructura.
- **Propuesta:** comenzar con pool Prisma de 8 conexiones por proceso API y 3 por proceso worker, y activar PgBouncer transaction pooling si las réplicas exceden el presupuesto de conexiones.
- **Pendiente:** proveedor PostgreSQL, máximo permitido, réplicas, latencia, versión exacta Prisma/PgBouncer y configuración prepared statements. La conexión de migración será directa.

### P-005 — Margen del cursor de sincronización

- **Estado:** Pendiente de pruebas.
- **Propuesta:** variable `SYNC_CURSOR_OVERLAP` para el replay; el ejemplo `100` en el documento de arquitectura es ilustrativo, no valor definitivo.
- **Pendiente:** fijar unidades/valor tras medir volumen de escrituras, duración máxima de transacciones y comportamiento real de commits concurrentes. Se debe decidir si el margen numérico es suficiente o si se requiere un watermark basado en commits.

### P-006 — Retención y eliminación física

- **Estado:** Pendiente de validación legal/operativa.
- **Propuesta:** borrado lógico en APIs; proceso controlado de retención/purga para base de datos y S3, con auditoría y revisión de referencias.
- **Pendiente:** plazos de retención y obligaciones de conservación **validar con abogado local**. No configurar expiración automática de documentos de usuarios activos sin esta aprobación.

### P-007 — Verificación de emergencia y catálogos locales

- **Estado:** Pendiente de fuentes.
- **Propuesta:** semillas idempotentes con catálogos de servicios, especialidades, marcas/modelos, departamentos/municipios y números de emergencia validados.
- **Pendiente:** fuente primaria y proceso de verificación de teléfonos de emergencia. Los números no verificados no se publican.

### P-008 — Integración WhatsApp fuera de OTP

- **Estado:** Pendiente de producto/integración.
- **Propuesta:** Twilio Verify se limita a OTP. WhatsApp es el canal principal de contacto directo entre usuario y taller/proveedor mediante enlace/acción del cliente. Notificaciones salientes automáticas por WhatsApp no se habilitan hasta seleccionar y aprobar proveedor/plantillas y costos B2B.
- **Motivo:** Verify no debe suponerse como servicio genérico de mensajería transaccional.

### P-009 — Límites y seguridad de archivos

- **Estado:** Pendiente de aceptación de producto/operaciones.
- **Propuesta:** allow-list de MIME, límites de bytes separados para documentos/fotos/comprobantes, validación real del archivo, staging y finalización a key inmutable.
- **Pendiente:** tamaño máximo por tipo, escaneo antimalware, retención de temporales y proceso de moderación de fotos.

### P-010 — Reglas de edición y moderación de reseñas

- **Estado:** Pendiente de producto.
- **Propuesta:** una reseña activa por usuario y negocio; moderación independiente de pauta publicitaria; respuesta única del dueño.
- **Pendiente:** ventana de edición/eliminación por autor, políticas antiabuso y causales de moderación.

## Consecuencias para las fases siguientes

- B0 crea el repositorio, bootstrap NestJS, configuración y estructura de módulos; no debe redefinir el stack.
- Las fases que creen tablas sincronizables deben usar la plantilla SYNC-READY y los triggers globales ya establecidos.
- Las fases de cifrado deben mantener `key_version`, AES-GCM, KMS envelope encryption e índices HMAC independientes.
- Los flujos B2B deben usar `Idempotency-Key` y persistencia PostgreSQL por 24 horas.
- Las fases de directorio/precios deben garantizar XOR de dueño, rangos USD y texto obligatorio en respuestas de precio de servicio.
- Las fases de archivos deben usar S3 privado y URLs firmadas; ninguna credencial de almacenamiento se entrega al cliente.
- No avanzar en pendientes P-001 a P-010 con decisiones implícitas. Resolverlos en la fase donde se vuelvan necesarios y registrar aprobación.

## Referencias técnicas consultadas

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

## Decisiones y pendientes añadidos por el contrato offline-first (2026-11-03)

### D-020 — Validez de cursores y retención de tombstones del protocolo sync

- **Estado:** implementada en B5S como ventana de validez del cursor; la purga física automatizada queda fuera de esta fase.
- **Decisión:** los cursores firmados y el estado de último pull expiran después de 90 días sin actividad. Un cursor vencido fuerza `410 SYNC_RESYNC_REQUIRED` y bootstrap completo. Los tombstones permanecen en PostgreSQL hasta que una política de retención futura los purgue; `sync_retention_state.minimum_valid_cursor` permite avanzar el límite mínimo sin cambiar el protocolo.
- **Consecuencia:** el cliente mantiene tombstones/versiones aplicadas localmente durante el solapamiento para evitar resurrecciones de registros; B5S no instala un job de purga física.

### D-021 — Código de purga local

- **Estado:** Aceptada por el contrato offline.
- **Decisión:** `LOCAL_DATA_PURGE_REQUIRED` (HTTP 401) ordena borrar todos los datos privados de la cuenta en el dispositivo, incluidos SQLite, archivos cifrados, cachés asociados, cola, cursores y tokens.
- **Consecuencia:** un `401 AUTH_REQUIRED` ordinario por expiración no desencadena por sí solo la purga.

### D-022 — Recordatorios de solo lectura para móvil

- **Estado:** Aceptada e implementada en B4/B5S.
- **Decisión:** el servidor calcula `Reminder` y `GET /reminders/schedule`; Flutter no crea, edita, pospone ni elimina recordatorios por `/sync/push`.
- **Consecuencia:** `Reminder` se incluye como lectura pull-only en el canal `reminders`; `NotificationPreference` es la entidad editable del conductor.

### P-011 — Sincronización del perfil

- **Estado:** Resuelto por D-060 e implementado en B5S.
- **Decisión:** `users.sync_version` más trigger propio para la proyección `profile`; el ID de `User` sigue siendo generado por servidor.
- **Restricción:** el cliente solo puede editar `display_name` y `email` (dato no verificado); no puede crear identidad ni cambiar teléfono, rol, estado o datos de autenticación.

### P-012 — Consentimiento offline (`ConsentLog`)

- **Estado:** Resuelto por D-032.
- **Decisión:** `ConsentLog` continúa server-only, append-only y fuera de `/sync/push`, `/sync/pull` y almacenamiento offline de negocio.

### P-013 — Alcance B5S para cuentas de negocio

- **Estado:** Resuelto por D-061.
- **Decisión:** B5S solo sincroniza los datos del conductor. Directorio y edición offline de talleres/proveedores requieren un contrato separado.

### P-014 — Solapamiento del cursor y commits fuera de orden

- **Estado:** Implementado con límite operativo documentado por D-062.
- **Decisión:** ventana de relectura de 5,000 versiones globales; el cliente deduplica por `(entity,id)` aplicando solo versiones superiores.
- **Límite:** una ventana finita no garantiza una transacción que confirme arbitrariamente tarde; no se presenta como garantía matemática.

### P-015 — Retención de `ProcessedMutation`

- **Estado:** Resuelto por D-063.
- **Decisión:** conservar resultados idempotentes cifrados al menos 180 días. B5S no instala una tarea automática de purga.

### P-016 — Estados de archivo en la API

- **Estado:** Resuelto por D-051 e implementado en B3/B5S.
- **Decisión:** `file_status` es el nombre canónico (`pendiente_subida`, `disponible`); nunca se sincronizan keys ni URLs firmadas.

### P-017 — Parámetros offline configurables

- **Estado:** Resuelto para el backend por D-064; parámetros de UX/Flutter permanecen fuera de B5S.
- **Decisión:** página 50, lote hasta 50 mutaciones, máximo 256 KiB por mutación y 12.5 MiB por lote; bootstrap 24 h y cursores con vigencia de 90 días. La cadencia de pull en primer plano y cuota local de archivos quedan configurables por la app.


## Decisiones aceptadas durante B0

### D-023 — Aislamiento de credenciales runtime y migración

- **Estado:** Aceptada e implementada en B0.
- **Decisión:** el proceso HTTP solo recibe `DATABASE_URL` con `app_runtime`. `DATABASE_MIGRATION_URL` solo se entrega al comando/job aislado de migración y exige el usuario `app_migrator`.
- **Consecuencia:** la API no puede ejecutar DDL ni conservar la contraseña del rol de migraciones; `db:migrate` y `db:status` fallan antes de iniciar si la URL no está configurada correctamente.

### D-024 — Pool y schema de Prisma 7

- **Estado:** Aceptada e implementada en B0.
- **Decisión:** `PrismaPg` configura `max`, `connectionTimeoutMillis`, `idleTimeoutMillis` y `schema` directamente a través de las opciones del adaptador. Se eliminan de la URL runtime los parámetros heredados `connection_limit`, `pool_timeout` y `schema` antes de enviarla al driver `pg`.
- **Consecuencia:** el timeout de adquisición es explícito y el esquema no depende de parámetros no interpretados por el driver.

### D-025 — SSL PostgreSQL runtime

- **Estado:** Aceptada e implementada en B0.
- **Decisión:** `DATABASE_SSL_MODE` configura directamente el objeto TLS de `pg`. Producción exige `verify-full`; se puede montar CA privada mediante `DATABASE_CA_CERT_PATH`. No se desactiva la validación de certificado en producción.
- **Consecuencia:** el CA debe estar disponible en el contenedor/host antes de iniciar la API.

### D-026 — Separación de claves locales

- **Estado:** Aceptada e implementada en B0.
- **Decisión:** `LOCAL_DATA_KEY_BASE64` y `LOCAL_BLIND_INDEX_KEY_BASE64` deben ser dos claves AES/HMAC independientes de 32 bytes; la validación rechaza claves idénticas.
- **Consecuencia:** los valores de `.env.example` son ficticios, distintos y exclusivamente de desarrollo.

### D-027 — Cobertura con módulos B0 vacíos

- **Estado:** Aceptada para B0.
- **Decisión:** no aplicar el 70% global a scaffolding sin lógica de negocio. Se mantienen pruebas unitarias, integración y cobertura informativa en CI; el mínimo del 70% se activa por lógica/módulo cuando exista dominio funcional.
- **Consecuencia:** no se relaja el requisito de cobertura para reglas de negocio; se evita que un umbral engañoso o inviable falle la fundación.

### D-028 — Operación de infraestructura fuera del prefijo de negocio

- **Estado:** Aceptada e implementada en B0.
- **Decisión:** `GET /health` y Swagger `/docs` quedan en raíz; rutas de dominio futuras usan `/api/v1`.
- **Consecuencia:** reverse proxy, CORS y monitores deben conservar explícitamente ambas rutas.

### D-029 — Rate limit inicial previo a autenticación

- **Estado:** Aceptada en B0 y ampliada en B1.
- **Decisión:** el guard global aplica ventana fija Redis por IP + método + ruta a rutas públicas y por usuario + dispositivo + método + ruta a rutas autenticadas. OTP aplica además un contador por teléfono usando HMAC ciego y contador horario atómico.
- **Consecuencia:** no se confía en `X-Forwarded-For` hasta definir proxies confiables. Los endpoints públicos como refresh/logout siguen dependiendo de IP y deben recalibrarse si el patrón de tráfico lo exige.


### D-030 — Protección de la secuencia global de sync

- **Estado:** Aceptada e implementada en B0.
- **Decisión:** `app_runtime` no recibe privilegios `USAGE`, `SELECT` ni `UPDATE` sobre secuencias por concesión global. La función trigger `SECURITY DEFINER`, propiedad de `app_migrator`, es la única vía para consumir `sync_version_seq`.
- **Consecuencia:** una secuencia propia de una tabla futura solo se concede explícitamente si esa tabla la necesita. Las entidades UUID v7 no requieren secuencia para sus IDs.

## Pendientes de aprobación detectados durante B0

### P-018 — Confianza en proxy y origen IP

- **Estado:** Pendiente antes de desplegar detrás de un reverse proxy o load balancer.
- **Pendiente:** definir IP ranges confiables y configurar `trust proxy` explícitamente. No habilitar `trust proxy=true` global sin conocer topología, para evitar falsificación de `X-Forwarded-For`.

### P-019 — Requisito de CA privada en producción

- **Estado:** Pendiente de proveedor de PostgreSQL.
- **Pendiente:** confirmar si la CA del proveedor está en el trust store de Node o requiere montar un PEM por `DATABASE_CA_CERT_PATH`; verificar la conexión TLS de producción en el entorno real.

### P-020 — Instalación reproducible

- **Estado:** Pendiente por restricción del entorno actual.
- **Pendiente:** generar y versionar `package-lock.json` con `npm install`, verificar dependencias y cambiar CI a `npm ci` una vez que exista el lockfile. Relacionado con F-006.

### P-021 — Verificación de B0 en un host Docker

- **Estado:** Pendiente de ejecución externa.
- **Pendiente:** ejecutar `docker compose up --build -d`, migración, Jest/Testcontainers y build Docker en una máquina con Docker y acceso al registro npm. Este entorno de generación no dispone de Docker ni resolución DNS al registro npm.

### P-022 — Clasificación de Reminder en sincronización

- **Estado:** Resuelto por D-022 e implementado en B5S.
- **Decisión:** `Reminder` conserva metadatos/versionado de servidor para aparecer en el canal `reminders` de `/sync/pull`, pero nunca admite mutaciones del móvil en `/sync/push`. `GET /reminders/schedule` sigue siendo la vista autoritativa del calendario. No se crea una entidad editable de recordatorio.

## Consecuencias de B0 para las fases siguientes

- `app_runtime` nunca recibe ni necesita `DATABASE_MIGRATION_URL`.
- Toda tabla sync-ready debe tener `id` UUID v7, `user_id` indexado, metadatos comunes y trigger global; usar `docs/sync-ready-template.md`.
- El esquema y pool de Prisma se configuran con opciones del adaptador `pg`.
- `docs/technical-findings.md` mantiene el registro priorizado; los hallazgos corregidos conservan su entrada y evidencia.

## Decisiones aceptadas durante B1

### D-031 — Dispositivo ligado desde la verificación OTP

- **Estado:** aceptada e implementada.
- **Decisión:** el cliente genera un UUID v7 de instalación antes de `POST /auth/otp/verify` y envía `device_id` + `platform`. El backend crea/actualiza `SyncDevice` dentro de la transacción del alta/login. Después del login, `POST /me/devices` registra el token FCM.
- **Consecuencia:** no se puede reutilizar el mismo `device_id` entre dos cuentas; para cambiar de cuenta se debe crear un nuevo identificador. El registro FCM no es requisito para emitir la sesión.

### D-032 — Consentimiento como evidencia server-only

- **Estado:** aceptada e implementada.
- **Decisión:** `ConsentLog` no es sync-ready, no consume `sync_version` y nunca entra en `/sync/push` ni `/sync/pull`. El alta exige aceptar la versión configurada `CONSENT_POLICY_VERSION` antes de crear identidad y emitir sesión.
- **Consecuencia:** el registro de consentimiento se guarda como evento append-only. IP/User-Agent se cifran con envelope encryption cuando están disponibles; la eliminación puede anonimizar exclusivamente esos campos, preservando aceptación, versión y fecha recibida por el servidor.

### D-033 — Umbrales iniciales de OTP

- **Estado:** aceptada para B1; umbrales sujetos a revisión operativa.
- **Decisión:** máximo de cinco intentos fallidos (invariante de negocio), bloqueo temporal inicial de 15 minutos, challenge de 300 segundos y máximo inicial de cinco solicitudes por número por hora.
- **Consecuencia:** reenviar OTP no reinicia el contador de fallos. Los valores de ventana/TTL/solicitudes se configuran por entorno; el máximo de cinco fallos no se puede elevar.

### D-034 — Refresh token ligado a dispositivo y detección de reutilización

- **Estado:** aceptada e implementada.
- **Decisión:** persistir únicamente SHA-256 del refresh JWT, asociarlo a `family_id` y `device_id`, rotar bajo bloqueo de fila `FOR UPDATE` y revocar familia, dispositivo y tokens FCM al detectar reutilización de un token consumido.
- **Consecuencia:** toda petición posterior con un JWT firmado de una cuenta/dispositivo revocado debe devolver `LOCAL_DATA_PURGE_REQUIRED` para que el cliente elimine sus datos privados locales.

### D-035 — Eliminación en dos pasos con estado protegido

- **Estado:** aceptada e implementada para el dominio de identidad B1.
- **Decisión:** primero cambiar a `deletion_pending`, revocar refresh tokens y FCM; después eliminar versiones y delete markers de los prefijos personales S3; finalmente revocar dispositivos, anonimizar IP/User-Agent del consentimiento y retirar los identificadores personales cifrados.
- **Consecuencia:** si S3 falla, la cuenta no se reactiva y `DELETE /me` puede reintentarse. El access JWT firmado puede reintentar esa operación incluso vencido mientras el estado sea `deletion_pending`. La purga de dominios futuros se agrega en sus respectivas fases.

### D-036 — Política de expiración y orden de validación para purga local

- **Estado:** aceptada e implementada.
- **Decisión:** el guard verifica la firma del JWT aun cuando haya expirado y consulta el estado de cuenta/dispositivo antes de responder `AUTH_REQUIRED`. Solo las firmas válidas permiten identificar una cuenta eliminada/revocada y responder `LOCAL_DATA_PURGE_REQUIRED`.
- **Consecuencia:** un token inválido/falsificado no puede provocar una purga dirigida a otra cuenta; un token válido vencido aún permite detectar borrado remoto. Una cuenta `deletion_pending` puede reintentar únicamente `DELETE /me`.

### D-037 — Correo electrónico como dato de perfil no verificado

- **Estado:** aceptada para B1.
- **Decisión:** `PATCH /me` permite guardar email cifrado e índice HMAC, pero B1 no lo verifica ni lo utiliza para autenticación o recuperación de cuenta.
- **Consecuencia:** un futuro flujo de verificación deberá registrar estado/fecha de verificación antes de utilizar el correo como factor de seguridad.

### D-038 — Consentimiento no afirma una hora de captura de cliente

- **Estado:** aceptada e implementada.
- **Decisión:** `ConsentLog.received_at` representa la hora autoritativa del servidor; `client_captured_at` queda NULL porque B1 no recibe ni valida una hora de captura del dispositivo.
- **Consecuencia:** se evita presentar la hora del servidor como si fuera una marca temporal confiable del cliente.


### D-039 — Huellas OTP protegidas e incrementos Redis atómicos

- **Estado:** aceptada e implementada en B1.
- **Decisión:** las claves Redis asociadas al teléfono se derivan mediante HMAC ciego con propósito separado (`auth.otp.rate_limit`); el contador horario se incrementa y asigna TTL en un único script Lua. El proveedor OTP simulado consume el challenge aprobado una sola vez.
- **Consecuencia:** una filtración de Redis no permite enumerar fácilmente números +505 mediante hashes simples y no existe una ventana entre `INCR` y `EXPIRE` que pueda dejar el contador horario persistente sin TTL.

### D-040 — Rate limit por identidad autenticada

- **Estado:** aceptada e implementada en B1.
- **Decisión:** el guard global mantiene IP+método+ruta para endpoints públicos y usa user_id+device_id+método+ruta cuando el JWT guard ya autenticó la solicitud.
- **Consecuencia:** los usuarios de una misma red no comparten el bucket de rutas autenticadas. Los límites públicos siguen protegidos por IP y reglas específicas como la cuota OTP por teléfono.

## Decisiones aceptadas durante B2

### D-041 — Vehículo sync-ready y UUID v7 del cliente

- **Estado:** aceptada e implementada.
- **Decisión:** `Vehicle.id` es obligatorio y lo genera el cliente como UUID v7. PostgreSQL asigna `sync_version` con el trigger global; el móvil no lo puede escribir. `created_at`, `updated_at` y `deleted_at` usan UTC y el borrado ordinario es lógico.
- **Consecuencia:** una mutación idempotente conserva el mismo ID. Un ID que ya fue borrado no se reutiliza (`VEHICLE_ID_RETIRED`). La implementación de `/sync/push` y `/sync/pull` sigue reservada a B5S.

### D-042 — Placa cifrada, normalización e índice ciego por propietario

- **Estado:** aceptada e implementada.
- **Decisión:** la API convierte la placa a mayúsculas y elimina espacios; cifra el valor con AES-256-GCM y calcula HMAC ciego para unicidad exacta por `user_id`. La base tiene índice único parcial para registros activos.
- **Consecuencia:** una misma placa se rechaza entre vehículos activos del mismo dueño; al marcar el vehículo como eliminado, la placa puede utilizarse en otro registro. El formato alfanumérico/guion de B2 es deliberadamente amplio y no se anuncia como validación oficial de placas nicaragüenses.

### D-043 — Límite de vehículos y concurrencia por cuenta

- **Estado:** aceptada e implementada.
- **Decisión:** máximo configurable mediante `MAX_VEHICLES_PER_USER`, con valor predeterminado 10 y rango permitido 1–100. El alta toma un advisory transaction lock por usuario antes de contar e insertar.
- **Consecuencia:** dos altas concurrentes no pueden superar el máximo por una condición de carrera; solo se cuentan vehículos no borrados.

### D-044 — Catálogos de vehículos públicos, versionados y no exhaustivos

- **Estado:** aceptada e implementada.
- **Decisión:** marcas y modelos son de solo lectura para el móvil y se consultan mediante ETag/versión. Los IDs de catálogo son opcionales; las etiquetas de marca/modelo se conservan en `brand_label` y `model_label` como snapshots para aceptar capturas manuales.
- **Consecuencia:** un catálogo incompleto no bloquea guardar el vehículo. Si se envía `model_id`, debe pertenecer al `brand_id`. El seed actual es una lista inicial de desarrollo/arranque, no un inventario oficial completo.

### D-045 — Foto del vehículo mediante URL firmada y estado server-managed

- **Estado:** aceptada e implementada.
- **Decisión:** el móvil solicita URL firmada y sube a un object key aleatorio generado por la API; confirma la carga y la API verifica el objeto en S3 antes de marcar `available`. MIME permitido: JPEG, PNG y WebP; tamaño por defecto 5 MiB, configurable mediante `VEHICLE_PHOTO_MAX_BYTES`.
- **Consecuencia:** el móvil nunca elige ni recibe la key S3. `photo_status` y tamaño son metadatos; las URLs firmadas son temporales y nunca se persisten como referencia duradera. El entorno dev/test puede usar almacenamiento simulado; producción exige modo S3 real.

### D-046 — Borrado lógico de vehículo coordina documentos y recordatorios existentes

- **Estado:** aceptada e implementada con compatibilidad entre fases.
- **Decisión:** al eliminar el vehículo se marca `deleted_at`, se conservan las keys privadas de fotografía en el tombstone para reconciliación y no se vuelven accesibles por API, se marcan lógicamente documentos/pólizas vinculados y se cancelan recordatorios no completados cuando sus tablas ya están instaladas.
- **Consecuencia:** B2 no adelanta modelos/endpoints de B3. Hasta que existan las tablas dependientes, el borrado del vehículo funciona por sí solo; al incorporarlas, las escrituras de documentos seguirán sus triggers y restricciones de propietario. Los objetos S3 se retiran best-effort y quedan sujetos a reconciliación documentada en F-044; el reemplazo/abandono de una foto todavía requiere una referencia durable de limpieza.

## Decisiones aceptadas durante B3

### D-047 — Documentos y pólizas sync-ready

- **Estado:** aceptada e implementada.
- **Decisión:** `VehicleDocument` e `InsurancePolicy` usan UUID v7 del cliente, `user_id`, timestamps UTC, borrado lógico y trigger global de `sync_version`. `Insurer` es catálogo público versionado y de solo lectura.
- **Consecuencia:** las mutaciones offline se aplicarán posteriormente mediante B5S; el cliente no puede mutar metadatos de almacenamiento ni el estado de archivo.

### D-048 — Flujo de archivo en tres pasos y verificación real

- **Estado:** aceptada e implementada.
- **Decisión:** registrar documento como `pendiente_subida`, solicitar URL firmada de 5 minutos, subir a S3 y confirmar. El backend verifica tamaño, MIME y magic bytes antes de establecer `disponible`; máximo 10 MiB y formatos PDF/JPEG/PNG/HEIC. Descarga GET firmada de 10 minutos.
- **Consecuencia:** no se entrega la key S3 al cliente. Una URL PUT vigente no se reemite para la misma key; tras expirar, la siguiente URL usa una key nueva para impedir sobrescrituras por URL antigua. Dev/test pueden simular storage; producción requiere inspección real del objeto y no acepta una confirmación no verificable.

### D-049 — Historial de renovación de pólizas

- **Estado:** aceptada e implementada.
- **Decisión:** una renovación crea un nuevo `InsurancePolicy` con UUID nuevo, archiva la póliza activa anterior y conserva `previous_policy_id`; se impone una sola póliza activa no eliminada por vehículo.
- **Consecuencia:** el historial es inmutable como secuencia de registros; no se sobrescriben vigencias antiguas.

### D-050 — AAD v2 vinculado a propietario y registro

- **Estado:** aceptada e implementada para nuevas escrituras de B2/B3.
- **Decisión:** cifrado AES-256-GCM incluye `user_id` y `record_id` en AAD y EncryptionContext KMS. `aad_version=1` sigue disponible para datos existentes; nuevas placas/VIN y números de póliza/teléfonos de siniestros usan v2.
- **Consecuencia:** una sustitución entre filas ya no descifra en el contexto v2. Los datos v1 no se rompen ni se migran masivamente; su re-cifrado se puede hacer gradualmente. B4 incorpora `token_aad_version` y AAD v2 en nuevas altas/rotaciones de tokens FCM, manteniendo v1 para tokens ya registrados.

### D-051 — Estados de archivo en español y vigencia local

- **Estado:** aceptada e implementada.
- **Decisión:** `file_status` usa `pendiente_subida` y `disponible`; el estado de vigencia se calcula como `vigente`, `por_vencer` o `vencido` en `America/Managua`. Umbral inicial 30 días, configurable mediante `DOCUMENT_EXPIRING_SOON_DAYS`.
- **Consecuencia:** el servidor es autoritativo para el estado del archivo y del vencimiento; el cliente no los calcula ni los envía como escritura.


## Decisiones aceptadas durante B4

### D-052 — Recordatorios generados por servidor y sincronización de solo lectura

- **Estado:** aceptada e implementada.
- **Decisión:** los recordatorios de vencimiento se crean con offsets 30/15/7/1/0 a la hora preferida de `America/Managua`; el servidor conserva el estado y el cliente solo consulta la agenda. `NotificationPreference` es sync-ready y `NotificationLog` es un evento técnico no sincronizado.
- **Consecuencia:** el móvil puede programar notificaciones locales sin conexión a partir de `/reminders/schedule`, sin poder alterar los vencimientos o las entregas del servidor.

### D-053 — PostgreSQL como fuente de verdad y BullMQ como ejecutor

- **Estado:** aceptada e implementada.
- **Decisión:** los jobs BullMQ se identifican por UUID del recordatorio; PostgreSQL reclama transiciones de estado y conserva logs, mientras Redis solo coordina ejecución/reintentos. Se usa backoff exponencial, recuperación de procesos abandonados y collapse key FCM.
- **Consecuencia:** reiniciar worker no vuelve a encolar recordatorios `sent`; la ventana de incertidumbre de un proveedor externo se documenta como entrega idempotente de mejor esfuerzo, no exactly-once matemático.

### D-054 — Preferencias y canales de notificación

- **Estado:** aceptada e implementada.
- **Decisión:** defaults `[30,15,7,1,0]`, hora `09:00`, zona fija Managua y canales push/local/in-app activados. Cambiar offsets u hora cancela y regenera la agenda pendiente dentro de la transacción.
- **Consecuencia:** `/reminders/schedule` devuelve únicamente fechas futuras dentro de 90 días y respeta `local_enabled`.

## Decisiones aceptadas durante B5

### D-055 — Catálogos por versión y caché Redis

- **Estado:** aceptada e implementada.
- **Decisión:** toda consulta de catálogo devuelve versión y ETag; `/catalogs/status` concentra las versiones. Redis conserva respuestas durante una hora en claves que incluyen la versión, mientras PostgreSQL sigue siendo fuente de verdad.
- **Consecuencia:** al cambiar cualquier registro, el trigger incrementa la versión y la siguiente consulta de catálogo no reutiliza una clave anterior.

### D-056 — Números de emergencia no verificados no se publican

- **Estado:** aceptada e implementada.
- **Decisión:** `EmergencyNumber.verified` inicia en `false`; para pasar a verdadero se exige fuente registrada y el servidor fija verificador y fecha. El catálogo público filtra `verified=true` e `is_active=true`. No hay números sembrados hasta que exista una lista revisada contra fuentes primarias.
- **Consecuencia:** es preferible mostrar temporalmente un catálogo vacío a publicar un número no confirmado que pueda perjudicar a una persona en una emergencia. Un trigger PostgreSQL invalida la verificación anterior ante cambios de teléfono/categoría/ámbito, incluso en escrituras que no pasen por el servicio HTTP.

### D-057 — Contactos de emergencia: máximo cinco y teléfono cifrado

- **Estado:** aceptada e implementada.
- **Decisión:** `EmergencyContact` es sync-ready con UUID v7, dueño inmutable, AAD v2 y máximo cinco registros activos. PostgreSQL refuerza el límite con advisory lock y trigger; el backend serializa cambios de contacto principal.
- **Consecuencia:** no se puede eludir el límite mediante solicitudes concurrentes o escrituras directas del rol runtime.

### D-058 — Mensaje de emergencia compartible, sin envío automático

- **Estado:** aceptada e implementada.
- **Decisión:** el endpoint valida vehículo propio y coordenadas, genera URL de mapa y una URL de WhatsApp con texto codificado; no guarda ubicación ni manda mensajes por cuenta del usuario.
- **Consecuencia:** el usuario conserva la decisión final de revisar y compartir su ubicación y datos personales.

### D-059 — Códigos territoriales internos

- **Estado:** aceptada e implementada.
- **Decisión:** los catálogos iniciales tienen 17 unidades administrativas y 153 municipios, con códigos internos estables; no se presentan como códigos oficiales mientras no se confirme una tabla de correspondencia vigente.
- **Consecuencia:** una futura actualización cartográfica podrá corregir nombres y asociaciones sin cambiar la identidad interna de catálogo si la entidad administrativa sigue siendo la misma.


## Decisiones aceptadas durante B5S — 2026-11-09

### D-060 — Perfil como proyección de identidad existente

- **Estado:** aceptada e implementada.
- **Decisión:** `users.sync_version` y trigger exclusivo de la proyección `profile`; el ID de identidad permanece creado por servidor. Solo `display_name` y `email` (dato de contacto no verificado) admiten mutación desde B5S.
- **Consecuencia:** OTP, teléfono, rol, estado de autorización, refresh tokens y atributos de dispositivo no se editan desde sync. Las actualizaciones de login/OTP no generan nuevas versiones ni modifican `users.updated_at` de la proyección de perfil, evitando falsos conflictos LWW.

### D-061 — Alcance B5S limitado al conductor

- **Estado:** aceptada e implementada.
- **Decisión:** los canales offline cubren el perfil y los datos propios del conductor; directorio y administración offline de talleres/proveedores quedan fuera.
- **Consecuencia:** los datos públicos de negocios se obtienen por búsquedas/cachés limitadas, no mediante réplica completa.

### D-062 — Ventana de solapamiento de 5,000 versiones

- **Estado:** aceptada e implementada con limitación conocida.
- **Decisión:** el pull reconsulta las últimas 5,000 versiones de `sync_version_seq`; el cliente aplica solo la versión mayor por `(entity,id)`.
- **Consecuencia:** reduce omisiones por commits fuera de orden dentro de ese margen, pero no garantiza capturar transacciones arbitrariamente largas.

### D-063 — Retención mínima de idempotencia sync

- **Estado:** aceptada e implementada.
- **Decisión:** `ProcessedMutation` guarda hash y resultado cifrado por al menos 180 días.
- **Consecuencia:** B5S no instala purga automática; una política futura de limpieza debe conservar la ventana de reintentos autorizada y considerar el estado del dispositivo.

### D-064 — Límites operacionales del protocolo B5S

- **Estado:** aceptada e implementada en backend.
- **Decisión:** página máxima 50; lote máximo 50 mutaciones; 256 KiB por mutación; 12.5 MiB por lote; sesión bootstrap 24 h; tokens/cursor con TTL de 90 días; tombstones sin purga física en B5S, sujetos a `minimum_valid_cursor` y a una futura política de retención; reloj de cliente adelantado se limita a servidor +5 minutos.
- **Consecuencia:** el cliente publica su cadencia de pull en primer plano y cuota de archivos local como configuración propia; el backend no impone polling ni una cuota de almacenamiento arbitraria.

### D-065 — Cursor independiente por dispositivo y canal

- **Estado:** aceptada e implementada.
- **Decisión:** `sync_channel_states` usa PK `(device_id,channel)` y guarda cursor/último pull por canal. Canales: `all`, `profile`, `vehicles`, `documents`, `policies`, `notification_preferences`, `emergency_contacts`, `assistance_requests`, `reminders`.
- **Consecuencia:** la lectura de un canal no avanza los cursores de los demás. `all` se mantiene como canal agregado.

### D-066 — Tokens opacos firmados para cursores y bootstrap

- **Estado:** aceptada e implementada.
- **Decisión:** cursores y page tokens son Base64URL + HMAC-SHA256, ligados a usuario/dispositivo/canal o sesión, y expiran. El endpoint no acepta cursores numéricos construidos por el cliente.
- **Consecuencia:** `snapshot_sync_version` es informativo; el cliente debe conservar literalmente `initial_cursors[channel]` y `next_cursor`, sin decodificar, modificar ni calcular su contenido.

## Decisiones aceptadas durante B6 — 2026-11-13

### D-067 — Búsqueda geoespacial con PostGIS y GiST

- **Estado:** implementada en B6; medición de rendimiento pendiente.
- **Decisión:** la búsqueda con coordenadas filtra primero con `ST_DWithin(geography(Point,4326), point, radius_meters)` y obtiene distancia en metros con `ST_Distance`. Se agrega índice GiST parcial sobre `workshops.location`.
- **Consecuencia:** radio y orden por distancia se resuelven en PostgreSQL. La meta menor a 300 ms para 5 000 talleres requiere medición posterior en el entorno de pruebas; no se declara validada por código.

### D-068 — Estados de talleres y publicación administrativa

- **Estado:** implementada en B6.
- **Decisión:** estados `draft`, `pending_verification`, `active` y `suspended`. El propietario puede solicitar verificación; solo `admin` puede activar/suspender. Todas las consultas públicas exigen `active` y `deleted_at IS NULL`.
- **Consecuencia:** un taller suspendido o pendiente no aparece en búsqueda, detalle, contacto ni eventos públicos.

### D-069 — Referencia local obligatoria y ubicación completa al activar

- **Estado:** implementada en B6.
- **Decisión:** PostgreSQL impone un CHECK que exige dirección, `address_reference_text`, ubicación geográfica, departamento y municipio para cualquier fila `active`. La referencia local es obligatoria; teléfono, WhatsApp y correo son opcionales y se cifran cuando se proporcionan. La API valida antes de actualizar estado.
- **Consecuencia:** la regla no depende únicamente del controller; una modificación directa de BD tampoco puede activar una ficha sin referencia local.

### D-070 — Horario semanal y cálculo `open_now`

- **Estado:** implementada en B6.
- **Decisión:** `weekly_schedule` es JSONB con intervalos `HH:MM` por día, zona horaria fija `America/Managua`, hasta cuatro intervalos por día, soporte de cierres que cruzan medianoche y `open == close` para 24 horas. PostgreSQL calcula `workshop_is_open_now` para filtrar en la búsqueda.
- **Consecuencia:** el resultado no depende de la zona horaria del móvil. Los intervalos superpuestos se rechazan en NestJS.

### D-071 — Precio estimado, USD canónico y desactualización

- **Estado:** implementada en B6.
- **Decisión:** `ServiceOffering` usa `price_min`, `price_max`, `currency='USD'`, `unit`, `notes` y `last_updated_at`. El trigger actualiza la fecha únicamente si cambia el precio, moneda, unidad o nota; cambios cosméticos del nombre/descripción no rejuvenecen el precio. Después de 90 días se expone `price_status='desactualizado'`.
- **Consecuencia:** toda respuesta que incluye precios agrega literalmente: “Precio estimado. El pago se realiza directamente al taller o al proveedor cuando se presta el servicio.” El NIO no se guarda como segundo precio editable.

### D-072 — Dueño XOR físico de ServiceOffering

- **Estado:** implementada en B6; script de aceptación SQL preparado y no ejecutado.
- **Decisión:** PostgreSQL exige `(workshop_id IS NOT NULL) <> (assistance_provider_id IS NOT NULL)` y FKs compuestas `(owner_id,user_id)` hacia `UNIQUE(id,user_id)` de cada dueño.
- **Consecuencia:** una oferta no puede quedar huérfana ni apuntar a dos dueños o al negocio de otro usuario. Se incorpora `AssistanceProvider` mínimo como ancla FK; su perfil completo queda en su fase.

### D-073 — Caché acotado del directorio y métricas de contacto sin PII

- **Estado:** implementada en B6.
- **Decisión:** las búsquedas responden `fetched_at`, `cache_ttl_seconds=604800` y máximo 50 elementos para el caché local del móvil. Redis utiliza 60 segundos y clave con versión global, invalidada mediante `INCR` O(1). `WorkshopContactEvent` registra solo taller, tipo y timestamp.
- **Consecuencia:** el móvil puede conservar el último resultado durante siete días como caché offline limitada; la app debe mostrar cuándo se capturó. Eventos no guardan IP, usuario, teléfono, dispositivo ni coordenadas del visitante.

### D-074 — Prioridad patrocinada reservada para B9

- **Estado:** implementada en B9.
- **Decisión:** búsqueda selecciona y ordena primero los talleres con una campaña activa, pagada y válida para el espacio; los criterios orgánicos mantienen su orden relativo.
- **Consecuencia:** todo resultado patrocinado se etiqueta y expone el identificador de campaña y su expiración de caché; rating y reseñas permanecen independientes.

### D-075 — Fixtures geoespaciales de 5 000 talleres solo en test

- **Estado:** seed incorporado; no ejecutado.
- **Decisión:** los 5 000 registros ficticios se crean exclusivamente desde `seedTesting()` cuando `NODE_ENV=test`, con coordenadas deterministas alrededor de Managua. Development y production no invocan este seed.
- **Consecuencia:** el conjunto sirve para medir búsqueda a 5 km sin contaminar información de desarrollo compartido o producción.


## Decisiones aceptadas durante B8 — 2026-11-13

### D-076 — Reseñas online-only y enfriamiento de seis meses

- **Estado:** implementada en backend.
- **Decisión:** una cuenta `user` puede crear una reseña por taller en una ventana móvil de seis meses. La operación bloquea la fila del taller y consulta el reloj PostgreSQL dentro de la transacción; la reseña inicia siempre `pending`. Las reseñas no se agregan a la réplica B5S del conductor.
- **Consecuencia:** reintentos concurrentes no eluden el período; incluso las reseñas posteriormente rechazadas/retiradas conservan su fecha para el límite de publicación.

### D-077 — Moderación y reputación independientes de publicidad

- **Estado:** implementada en backend; validación integral pendiente.
- **Decisión:** solo un usuario administrador activo puede aprobar, rechazar o retirar una reseña. El propietario del taller solo puede responder una vez a una reseña publicada o reportarla; no existen endpoints para editar, ocultar, borrar o reordenar reseñas.
- **Consecuencia:** triggers PostgreSQL hacen inmutable el contenido de reseñas, impiden el borrado físico y bloquean escrituras directas de `rating_average`/`rating_count`. El promedio y total se recalculan transaccionalmente con reseñas publicadas no retiradas; una campaña publicitaria no concede permisos de reputación.

### D-078 — Reportes de reseñas con motivo y moderación administrativa

- **Estado:** implementada en backend.
- **Decisión:** usuarios pueden reportar reseñas publicadas; un propietario solo puede reportar reseñas de su propio taller. El motivo es obligatorio (10–500 caracteres), con un reporte abierto por cuenta/reseña. Solo administración resuelve o descarta.
- **Consecuencia:** un reporte no cambia automáticamente visibilidad ni puntuación; la decisión sobre la reseña continúa en la cola de moderación.
