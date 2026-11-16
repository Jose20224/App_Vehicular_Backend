# Registro de hallazgos técnicos y decisiones pendientes

**Proyecto:** API de gestión vehicular y asistencia en carretera para Nicaragua  
**Creado:** 2026-11-03  
**Alcance:** observaciones detectadas al implementar y revisar las fases previas y B0. Este documento no autoriza cambiar los contratos aprobados. Cada elemento se valida con el propietario antes de modificar una fase.

## Criterio de prioridad

- **Urgente:** puede comprometer integridad, seguridad, sincronización o bloquear una fase cercana. Debe resolverse antes de implementar la parte afectada.
- **Moderado:** no bloquea B0, pero requiere decisión o comprobación antes de la fase que lo consuma o antes de producción.
- **No tan urgente:** mejora, limpieza o decisión que puede esperar sin poner en riesgo el alcance actual.

## Urgente

### F-001 — Inconsistencia entre el perfil y `User` en el contrato offline

- **Origen:** `offline-sync-contract.md` define el perfil como bidireccional, pero el diccionario deja `User` fuera de sync-ready y asigna el ID desde el servidor.
- **Riesgo:** B5S podría terminar permitiendo que el cliente mutase identidad/rol/teléfono o, en el extremo contrario, dejar el perfil sin sincronización.
- **Estado:** resuelto por D-060 e implementado en B5S. `users.sync_version` versiona la proyección limitada sin cambiar el origen server-generated del ID.
- **Resolución:** solo `display_name` y `email` no verificado son editables; rol, teléfono, OTP, estado, sesiones y dispositivos permanecen fuera de push.
- **Fase afectada:** B5S.

### F-002 — Cursor global basado en secuencia y commits fuera de orden

- **Origen:** la secuencia global asigna números al escribir, pero PostgreSQL no garantiza que las transacciones confirmen en el mismo orden en que obtuvieron `nextval`.
- **Riesgo:** una transacción antigua puede confirmar después de que un cliente haya avanzado el cursor más allá de su versión. Una ventana finita de solapamiento no protege ante una transacción arbitrariamente larga.
- **Estado:** resuelto para la implementación por D-062 con una ventana fija de 5,000 versiones; se conserva como limitación operativa abierta.
- **Resolución:** B5S reconsulta el solapamiento y el cliente deduplica por entidad/ID/versión. Una transacción que confirme arbitrariamente tarde aún puede quedar fuera; la observabilidad de duración de transacciones y una eventual estrategia basada en commits/reconciliación son tareas previas a producción, no bloquean la escritura de esta fase.
- **Fase afectada:** B5S y operación.

### F-003 — Orden monotónico de `sync_version` entre sesiones PostgreSQL

- **Origen:** un `CACHE` de secuencia mayor que 1 puede reservar bloques por sesión y entregar valores fuera de orden entre conexiones, aunque se use una secuencia única.
- **Riesgo:** se rompería la premisa del cursor numérico global por asignación.
- **Estado:** corregido en B0; `sync_version_seq` usa `CACHE 1`. Aun así, el orden de commit sigue siendo distinto del orden de asignación (F-002).
- **Acción preventiva:** conservar `CACHE 1` salvo prueba/decisión expresa. La fase B5S conserva esta configuración y usa una ventana de solapamiento documentada; la observabilidad de transacciones largas queda como tarea operativa previa a producción.

### F-041 — Cobertura y ejecución de aceptación B1 pendientes de validación local

- **Prioridad:** no tan urgente para continuar el desarrollo; revisar en validación local antes del despliegue.
- **Origen:** las pruebas unitarias de OTP, consentimiento, rotación refresh, eliminación, guards y configuración están escritas, pero no fue posible instalar dependencias: `npm install --no-audit --no-fund` agotó 120 segundos. Este entorno tampoco dispone del ejecutable Docker.
- **Riesgo:** no hay evidencia ejecutable de que Jest, TypeScript type-check, lint, Prisma Client/migración, Testcontainers, Docker Compose o la imagen CI pasen. El mínimo de 70 % de cobertura de lógica tampoco ha sido medido; por indicación del propietario estas comprobaciones se realizan en su equipo y no bloquean la continuación de fases.
- **Estado:** pendiente de validación externa. La transpilación sintáctica de TypeScript y `git diff --check` sí pasaron; estos controles no sustituyen compilación, tipado ni tests.
- **Acción requerida:** en un host con acceso a npm y Docker, instalar dependencias, crear/versionar `package-lock.json`, ejecutar `npm run lint`, `npm run build`, `npm run test:ci`, `npm run test:e2e`, `npm run test:migrations` y `docker compose up --build`; resolver fallos y demostrar cobertura de lógica ≥70 % antes del despliegue, sin bloquear B2 y fases siguientes.
- **Fase afectada:** validación local de B1/CI antes del despliegue. Por indicación del propietario, no bloquea la implementación de fases posteriores.

## Moderado

### F-004 — `Reminder` aparece como sync-ready en el diccionario, pero el cliente solo puede leerlo

- **Origen:** el diccionario de datos y el contrato offline tienen direcciones de sincronización distintas.
- **Riesgo:** un DTO genérico podría aceptar mutaciones de recordatorios calculados por el servidor.
- **Estado:** resuelto en B4/B5S: el diccionario y contrato declaran `Reminder` pull-only; la allow-list de `/sync/push` excluye `Reminder` y `NotificationLog`. `NotificationPreference` conserva sync-ready.
- **Fase afectada:** B5S / recordatorios.

### F-005 — Aprovisionamiento de extensiones en producción

- **Origen:** `app_migrator` no es superusuario y las extensiones PostGIS/pgcrypto se instalan en el bootstrap local como usuario administrador.
- **Riesgo:** `prisma migrate deploy` fallará si producción no ha habilitado previamente las extensiones.
- **Estado:** explícito en B0. El despliegue debe provisionar/verificar extensiones con el administrador o proveedor antes de las migraciones.
- **Recomendación:** documentar el paso por proveedor y comprobar `pg_extension` en preflight de despliegue.
- **Fase afectada:** despliegue inicial y cambios de infraestructura.

### F-006 — Falta `package-lock.json` reproducible en el artefacto inicial

- **Origen:** el entorno de generación no pudo resolver `registry.npmjs.org`; no fue posible ejecutar `npm install` ni materializar un lockfile.
- **Riesgo:** las dependencias directas están fijadas en `package.json`, pero algunas dependencias transitivas pueden resolverse a versiones distintas.
- **Estado:** sigue pendiente. Durante B1 se volvió a intentar `npm install --no-audit --no-fund`; el comando agotó 120 segundos sin completar y no creó `node_modules` ni `package-lock.json`.
- **Recomendación:** ejecutar `npm install`, revisar y versionar `package-lock.json`, y cambiar el workflow a `npm ci` + caché npm antes de considerar CI plenamente reproducible.
- **Fase afectada:** antes de abrir PRs y activar CI remoto.

### F-007 — Rate limit inicial usa IP y ruta, no identidad autenticada

- **Origen:** B0 todavía no implementa JWT ni `device_id`; el guard usa IP + método + path y Redis.
- **Riesgo:** usuarios detrás de una IP compartida pueden compartir cuota; una política por ruta sensible será más estricta que el límite global.
- **Estado:** parcialmente resuelto en B1: rutas autenticadas usan user_id + device_id + método + ruta; endpoints públicos mantienen IP + método + ruta. OTP añade cuota horaria por teléfono mediante HMAC.
- **Riesgo pendiente:** refresh/logout siguen siendo públicos respecto al access token y quedan limitados por IP; revisar el presupuesto tras conocer el reverse proxy y el patrón real de sesiones.
- **Recomendación:** calibrar cuotas por operación sensible y configurar `trust proxy` solo con rangos confiables cuando se elija el hosting.
- **Fase afectada:** auth y endpoints sensibles.

### F-008 — Semillas de catálogos no pueden incluir números de emergencia sin fuente verificada

- **Origen:** no se ha entregado una fuente oficial verificada para números de Nicaragua.
- **Riesgo:** publicar números inventados o desactualizados puede retrasar la atención de una emergencia.
- **Estado:** resuelto preventivamente en B5. No se insertan teléfonos en seeds; el panel/API admin permite registrarlos inicialmente como `verified=false`, y el catálogo público solo expone números activos verificados con fuente y responsable.
- **Acción pendiente:** incorporar números reales únicamente después de contrastarlos con una fuente primaria y registrar fecha, alcance territorial y responsable de verificación.
- **Fase afectada:** catálogos / operación.

### F-009 — Las rutas operativas quedan fuera de `/api/v1`

- **Origen:** el requerimiento define `/health` y `/docs`, mientras las rutas de negocio usan `/api/v1`.
- **Riesgo:** bajo, pero un proxy o monitor que asuma que todo está prefijado no encontrará esos recursos.
- **Estado:** decisión técnica de B0: `/health` y `/docs` son rutas de infraestructura en raíz; solo endpoints de negocio usan `/api/v1`.
- **Recomendación:** conservar ambas excepciones en proxy, CORS y monitoreo.

### F-010 — Rollback de migración Prisma no equivale a rollback operativo de producción

- **Origen:** Prisma no ofrece una reversa general; `rollback.sql` elimina objetos de la migración, pero no modifica automáticamente el ledger `_prisma_migrations`.
- **Riesgo:** ejecutar el script en producción puede dejar el ledger indicando una migración aplicada mientras los objetos se retiraron.
- **Estado:** el script B0 está destinado a pruebas aisladas; producción mantiene expandir/contraer y corrección hacia adelante.
- **Recomendación:** no ejecutar `rollback.sql` manualmente en producción. Una reversa real requiere procedimiento operable con `prisma migrate resolve` y aprobación específica, o restauración de base.
- **Fase afectada:** despliegue/operación de todas las migraciones.

### F-011 — El formato Base64 de URL/secretos en Docker Compose debe evitar caracteres reservados

- **Origen:** Compose construye `DATABASE_URL` y `REDIS_URL` con interpolación de contraseñas.
- **Riesgo:** caracteres como `@`, `:`, `/`, `?` o `#` requieren URL encoding.
- **Estado:** `.env.example` usa valores URL-safe.
- **Recomendación:** usar secretos aleatorios Base64URL o inyectar las URLs ya codificadas en entornos no locales; no concatenar contraseñas arbitrarias sin codificación.

## No tan urgente

### F-012 — El almacenamiento de sesiones y claves JWT no forma parte de B0

- **Origen:** B0 valida presencia y longitud de secretos JWT, pero no implementa todavía access/refresh ni revocación.
- **Riesgo:** ninguno para la fundación; no debe interpretarse como autenticación disponible.
- **Estado:** esperado; implementar en la fase de autenticación.

### F-013 — El porcentaje global de cobertura no es significativo con módulos vacíos

- **Origen:** B0 no contiene lógica de negocio y los módulos de dominio son scaffolds vacíos.
- **Riesgo:** un umbral global prematuro penalizaría archivos de bootstrap/infraestructura sin reglas de negocio.
- **Estado:** pendiente de calibración. Se mantienen tests de configuración, contrato de error, health y migraciones; el 70% se aplicará a la lógica de negocio según se implemente en módulos.
- **Recomendación:** acordar más adelante cobertura por módulo/dominio y excluir scaffolds, wiring y código generado.

### F-014 — Tipos exactos de imagen Docker y versiones menores deben revisarse periódicamente

- **Origen:** PostGIS, Redis y Node usan tags menores fijados en Compose/Dockerfile.
- **Riesgo:** recibir parches requiere actualizar tags y verificar extensiones.
- **Estado:** mantenimiento normal; no bloquear B0.
- **Recomendación:** fijar digest de imágenes en producción y actualizar mediante PR con CI.

### F-015 — Directorio y servicios futuros aún no tienen endpoints

- **Origen:** los módulos de negocio se crean vacíos por alcance B0.
- **Riesgo:** ninguna función de usuario está disponible todavía.
- **Estado:** esperado, no defecto de B0.

## Historial de revisión

| Fecha | Fase | Acción |
|---|---|---|
| 2026-11-03 | B0 | Registro inicial; F-003 corregido en la migración; los demás puntos quedan sujetos a revisión. |


## Hallazgos nuevos detectados durante B0

### Urgente

### F-016 — Configuración de Prisma 7 con driver adapter `pg`

- **Origen:** los parámetros `connection_limit`, `pool_timeout` y `schema` estaban en la URL runtime y se pasaban directamente a `PrismaPg`; Prisma ORM 7 con driver adapter configura pool y schema mediante las opciones del adaptador.
- **Riesgo:** opciones no reconocidas podrían ignorarse o terminar en errores de conexión; el pool y el schema quedarían distintos a lo esperado.
- **Estado:** corregido en B0: se extrae `schema`, se eliminan parámetros heredados de la URL y se configuran `max`, `connectionTimeoutMillis`, `idleTimeoutMillis` y `{ schema }` en `PrismaPg`.
- **Verificación pendiente:** requiere `npm install` y test real contra PostGIS/Testcontainers.
- **Referencia:** [Prisma ORM 7 — PostgreSQL driver adapters](https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/postgresql#using-driver-adapters).

### F-017 — La API no debe recibir la credencial `app_migrator`

- **Origen:** la primera versión de B0 requería `DATABASE_MIGRATION_URL` en la validación global e inyectaba `.env` completo en el contenedor API.
- **Riesgo:** la credencial DDL quedaría en el proceso de solicitudes HTTP, aunque el rol runtime separado no la necesitara.
- **Estado:** corregido: el validador de la API ya no solicita ni expone esa variable; Compose pasa solo configuración runtime a `api`; `migrate` es un job separado. `db:migrate` y `db:status` validan la URL y que el usuario sea `app_migrator`.
- **Fase afectada:** B0 y despliegue.

### F-018 — Plantilla sync-ready incompleta

- **Origen:** la utilidad inicial omitía `user_id` y no declaraba formalmente la restricción UUID v7.
- **Riesgo:** las futuras tablas podían cumplir parcialmente la convención y omitir el filtro/índice por dueño.
- **Estado:** corregido: `SyncReadyMetadata`, plantilla SQL y guía nueva exigen `user_id`, índice B-tree, UUID v7 y trigger.
- **Verificación pendiente:** revisar la primera migración de negocio real; la utilidad no sustituye revisar el DDL de cada tabla.

### F-024 — Permisos de secuencia global demasiado amplios

- **Prioridad:** urgente.
- **Origen:** la primera plantilla de roles concedía `USAGE, SELECT` sobre todas las secuencias a `app_runtime`.
- **Riesgo:** el proceso API podría consumir directamente `sync_version_seq`, incumpliendo el aislamiento previsto aunque el trigger siga reemplazando el valor enviado.
- **Estado:** corregido: se eliminaron grants globales a secuencias y el test de migración comprueba que `app_runtime` no puede ejecutar `nextval(sync_version_seq)` pero el trigger sí.

### Moderado

### F-019 — Umbral global de 70% en B0 sin lógica de negocio

- **Origen:** Jest tenía un `coverageThreshold` global de 70% aunque los módulos de negocio son vacíos por alcance.
- **Riesgo:** CI fallaría por archivos de wiring/arranque sin lógica y no mediría la calidad de negocio.
- **Estado:** corregido: B0 genera reporte de cobertura sin umbral global; el 70% se activará por módulo cuando exista lógica de negocio testeable, tal como ya se documentó.

### F-020 — Claves de cifrado e índice ciego iguales en ejemplos

- **Origen:** `.env.example` y los tests usaban la misma clave Base64 para datos e índice HMAC.
- **Riesgo:** incumplir separación criptográfica de propósitos y normalizar una práctica peligrosa.
- **Estado:** corregido: ejemplos distintos y validador rechaza claves idénticas en `local`/`test`. Los valores continúan siendo ficticios, no secretos de producción.

### F-021 — CA PostgreSQL no aplicada por Prisma runtime

- **Origen:** `DATABASE_CA_CERT_PATH` se validaba pero no se pasaba al driver.
- **Riesgo:** conexiones a proveedores con CA privada podían fallar o quedar sin la política de TLS esperada.
- **Estado:** corregido: `PrismaService` configura `ssl` directamente, carga PEM si se suministra y activa `rejectUnauthorized` en `verify-full`.
- **Verificación pendiente:** conexión real con CA del proveedor de producción.
- **Referencia:** [Prisma ORM 7 — SSL para adapter-pg](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7#ssl-certificate-validation-changes).

### F-022 — Ejecución local de pruebas y Docker no disponible

- **Origen:** este entorno de generación no dispone del ejecutable Docker ni resuelve `registry.npmjs.org`.
- **Riesgo:** no se puede afirmar que Testcontainers, Docker Compose, la compilación ni el pipeline se hayan ejecutado correctamente aquí.
- **Estado:** no es defecto del código; bloquea la verificación local final. El workflow CI queda preparado para ejecutar esas pruebas en un runner con Docker y acceso npm.
- **Acción requerida:** completar `npm install`, crear `package-lock.json`, ejecutar lint/tests/build y `docker compose up --build` en un host habilitado.

### F-023 — Rate limit sin `trust proxy` validado

- **Origen:** B0 mantiene `trust proxy=false` y el guard agrupa por `request.ip`.
- **Riesgo:** detrás de un proxy todos los usuarios podrían aparecer bajo una misma IP; activar `trust proxy` sin lista de proxy confiable permitiría suplantar `X-Forwarded-For`.
- **Estado:** controlado/pending: se conserva `false` hasta que el despliegue real defina rangos proxy. Se añade P-018 en `decisions.md`.


### No tan urgente
### F-025 — Los módulos de dominio se incorporan por fases

- **Prioridad:** no tan urgente.
- **Origen:** B0 creó los 13 módulos como scaffolds vacíos.
- **Riesgo:** los dominios aún no implementados no deben confundirse con endpoints disponibles.
- **Estado:** actualizado en B2: `vehicles` y la lectura de catálogos de vehículos ya contienen servicios/endpoints; el resto sigue vacío según el plan de fases. No es una omisión accidental.
- **Acción:** continuar activando módulos únicamente en su fase correspondiente.


## Historial de revisión actualizado

| Fecha | Fase | Acción |
|---|---|---|
| 2026-11-03 | B0 | Corregidos F-003, F-016, F-017, F-018, F-019, F-020 y F-021 en el árbol generado; F-022 requiere verificación en host con Docker/npm; F-024 se corrigió restringiendo `sync_version_seq` al trigger. |


### F-026 — Variables de bootstrap de PostgreSQL heredadas por el contenedor API

- **Prioridad:** urgente.
- **Origen:** `api` utiliza `.env` como `env_file`; incluir en ese archivo `POSTGRES_PASSWORD`, `APP_MIGRATOR_PASSWORD` o `APP_RUNTIME_PASSWORD` expone al proceso HTTP credenciales que no necesita.
- **Riesgo:** ampliar el impacto de una vulnerabilidad de la API y romper la separación entre runtime, migraciones y administración.
- **Estado:** corregido en B0: `.env.example` contiene solo configuración de aplicación; las contraseñas bootstrap se resuelven mediante valores locales por defecto de Compose y no se inyectan al contenedor API. El runtime recibe únicamente `DATABASE_URL` del rol `app_runtime`. El servicio `migrate` recibe la URL del rol `app_migrator` de forma aislada.
- **Verificación pendiente:** inspeccionar `docker compose config` en host con Docker y comprobar que `api` no contiene `APP_MIGRATOR_PASSWORD`, `POSTGRES_PASSWORD` ni `DATABASE_MIGRATION_URL`.

## Hallazgos nuevos detectados durante B1

### Urgente

### F-027 — Exportación y eliminación todavía cubren solo identidad

- **Prioridad:** urgente antes de habilitar producción para usuarios con datos de negocio.
- **Origen:** B1 implementa identidad, consentimientos, dispositivos y prefijos S3 `users/{user_id}/` y `exports/{user_id}/`; todavía no existen las tablas ni servicios de vehículos, documentos, pólizas, solicitudes de asistencia, talleres, proveedores, reseñas o facturación.
- **Riesgo:** anunciar hoy una exportación/eliminación integral sin incluir los dominios futuros sería incorrecto; archivos de proveedores/talleres y registros sujetos a retención no se tocan desde B1.
- **Estado:** documentado y delimitado en `docs/auth-contract.md`; no se simula una cascada inexistente.
- **Acción requerida:** cada fase que incorpore datos personales deberá añadir su handler de exportación, anonimización/borrado lógico y política de objetos S3. Antes del lanzamiento debe existir una orquestación de cuenta que coordine todos los dominios y las obligaciones revisadas como “validar con abogado local”.

### F-028 — El éxito de borrado S3 depende de permisos para versiones y delete markers

- **Prioridad:** urgente antes de activar `S3_CLEANUP_MODE=s3` en producción.
- **Origen:** la limpieza usa `ListObjectVersions` y `DeleteObjects` con `VersionId` para purgar todas las versiones y marcadores de borrado de los prefijos personales.
- **Riesgo:** una política IAM que solo permita `s3:DeleteObject` o `s3:ListBucket` puede dejar versiones privadas recuperables y la cuenta en `deletion_pending`.
- **Estado:** código preparado; política IAM real no verificada en este entorno.
- **Acción requerida:** conceder mínimo `s3:ListBucketVersions` para el bucket y `s3:DeleteObjectVersion`/`s3:DeleteObject` limitado a los prefijos autorizados; probar en bucket de staging con versioning activo y denegaciones deliberadas.

### Moderado

### F-029 — Correo electrónico no verificado en B1

- **Prioridad:** moderado.
- **Origen:** `PATCH /me` guarda email cifrado y HMAC, pero no hay OTP/email-link de verificación.
- **Riesgo:** una dirección mal escrita o de terceros podría mostrarse como dato de perfil válido y no debe usarse para recuperar cuenta ni para notificaciones críticas.
- **Estado:** delimitado en `docs/auth-contract.md` y `decisions.md` D-037.
- **Acción requerida:** agregar `email_verified_at` y un flujo independiente solo si el producto decide usar email para comunicación autenticada o recuperación.

### F-030 — Umbrales iniciales de OTP requieren calibración operativa

- **Prioridad:** moderado.
- **Origen:** B1 usa 5 solicitudes por número/hora, challenge de 300 s y bloqueo de 15 min; el requisito de exactamente cinco fallos sí es invariante, pero los otros valores no venían definidos por producto.
- **Riesgo:** un límite demasiado estricto puede bloquear usuarios legítimos; uno demasiado laxo puede facilitar abuso y costos de Twilio.
- **Estado:** implementado como configuración y registrado en D-033.
- **Acción requerida:** revisar métricas de abuso/entrega antes de producción, sin elevar `OTP_MAX_FAILED_ATTEMPTS` por encima de cinco.

### F-031 — `device_id` se debe generar antes del OTP y es único entre cuentas

- **Prioridad:** moderado.
- **Origen:** para ligar refresh y access tokens a `SyncDevice`, el móvil envía UUID v7 y plataforma durante `POST /auth/otp/verify`; `POST /me/devices` registra FCM después.
- **Riesgo:** una implementación Flutter que genere el ID después de autenticar o reutilice el ID al cambiar de cuenta recibirá `DEVICE_ID_IN_USE`/`DEVICE_MISMATCH`.
- **Estado:** explicado en `docs/auth-contract.md` y en el ciclo de vida de `offline-sync-contract.md`.
- **Acción requerida:** incluir la generación/persistencia protegida de `device_id` en el futuro prompt Flutter; al cambiar de cuenta, generar otro UUID v7 y limpiar la base local anterior.

### F-032 — Clave KMS para índices ciegos requiere tipo HMAC y permisos separados

- **Prioridad:** moderado antes de producción.
- **Origen:** B1 calcula los índices ciegos con `GenerateMac(HMAC_SHA_256)` y `AWS_KMS_BLIND_INDEX_KEY_ARN`, separado de la CMK de datos AES.
- **Riesgo:** una clave simétrica de cifrado normal no sirve para `GenerateMac`; permisos o tipo de clave incorrectos impiden login/lookup de cuenta.
- **Estado:** documentado en `architecture.md`; no se ha provisionado ni probado una clave AWS en este entorno.
- **Acción requerida:** crear clave KMS de tipo `HMAC_256`, aplicar policy IAM mínima para `kms:GenerateMac`, y probar el mismo ARN/versionado en integración/staging.

### F-033 — ConsentLog conserva evidencia vinculada por `user_id`

- **Prioridad:** moderado; requiere validación legal antes de producción.
- **Origen:** al eliminar la cuenta se anonimizan IP/User-Agent y los datos personales de User, pero `ConsentLog` conserva `user_id`, tipo, versión, aceptación y `received_at` como evidencia append-only.
- **Riesgo:** la interpretación de si esta retención y vinculación residual es necesaria/proporcional depende del marco legal y la política de privacidad final.
- **Estado:** decisión técnica implementada; no se emite afirmación jurídica.
- **Acción requerida:** “validar con abogado local” la conservación, base/propósito y plazo; ajustar solo con una decisión aprobada.

### F-034 — Limpieza S3 tras fallo no tiene aún worker de reconciliación

- **Prioridad:** moderado.
- **Origen:** si S3 falla, `DELETE /me` queda en `deletion_pending` y el usuario debe repetir la operación; B1 no programa un job BullMQ de reintento.
- **Riesgo:** una cuenta puede permanecer protegida pero sin completar la purga mientras el cliente no reintente.
- **Estado:** comportamiento explícito y recuperable en B1; no se reactiva la cuenta ni se acepta login.
- **Acción requerida:** cuando B2/B3 incorporen workers, valorar una cola de reconciliación para account deletion con job idempotente y alerta de pendientes envejecidos.

### F-035 — `OTP_MAX_REQUESTS_PER_HOUR` limita por teléfono, no sustituye el rate limit por IP/dispositivo

- **Prioridad:** moderado.
- **Origen:** servicio OTP aplica un contador Redis por HMAC de teléfono; el guard global B0 limita IP+método+ruta.
- **Riesgo:** abuso distribuido o redes móviles compartidas pueden requerir cuotas diferenciadas, y el `trust proxy` sigue pendiente de infraestructura real (F-023).
- **Estado:** defensa en capas implementada, sin asumir una topología de proxy.
- **Acción requerida:** medir y revisar límites; configurar `trust proxy` solo con rangos confiables cuando se elija el hosting.

### F-036 — El export B1 es JSON síncrono y limitado a identidad

- **Prioridad:** no bloquea las siguientes fases.
- **Origen:** `GET /me/export` prepara perfil, ConsentLog y metadatos de SyncDevice en una respuesta JSON.
- **Riesgo:** cuando se agreguen archivos y grandes historiales, el payload puede ser pesado y lento.
- **Estado:** adecuado al volumen de identidad B1; alcance parcial documentado.
- **Acción requerida:** valorar exportación asíncrona con archivo S3 firmado solo cuando el volumen de dominios lo justifique.

### F-037 — Verificación real de Twilio Verify y KMS requiere credenciales de entorno

- **Prioridad:** moderado antes de producción.
- **Origen:** la implementación usa los endpoints Verify SMS/WhatsApp y SDK AWS KMS; las pruebas unitarias son mocks y no se dispone de credenciales externas.
- **Riesgo:** configuración de sender/WhatsApp, políticas de KMS, límites de cuenta o IAM podrían diferir del comportamiento simulado.
- **Estado:** integración de proveedor implementada; pruebas externas pendientes.
- **Acción requerida:** ejecutar pruebas controladas en staging con números y cuentas autorizados, sin incluir credenciales en Git.

### No tan urgente

### F-038 — Metadatos de dispositivo y correo podrían tener flujos de mantenimiento adicionales

- **Prioridad:** no tan urgente.
- **Origen:** B1 actualiza `last_seen_at` y el perfil, pero no implementa una vista de administración de sesiones ni la verificación del email.
- **Riesgo:** soporte y UX de administración de dispositivos son básicos en esta fase.
- **Estado:** fuera del alcance B1.
- **Acción requerida:** valorar una pantalla/endpoint de dispositivos activos y flujo de verificación de correo en fases posteriores, sin convertirlo en dependencia de login OTP.

## Correcciones pequeñas aplicadas durante B1

- El reenvío de OTP ya no reinicia el contador de intentos fallidos.
- `ResourceOwnerGuard` quedó registrado globalmente y solo ejecuta SQL para endpoints con decorador de propiedad.
- La rotación refresh usa bloqueo de fila explícito en lugar de aislamiento `Serializable` innecesario.
- Los JWT firmados expirados se comprueban contra el estado de cuenta/dispositivo antes de contestar `AUTH_REQUIRED`, para detectar borrado remoto; solo `DELETE /me` puede reintentarse con token expirado durante `deletion_pending`.
- `ConsentLog` sale del modelo sync-ready, cifra IP/User-Agent y restringe la única actualización permitida a anonimizar esos campos; checks SQL evitan metadata cifrada parcial.
- `PATCH /me` usa condición `status='active' AND deleted_at IS NULL` para no volver a escribir datos personales mientras una eliminación concurrente avanza.
- El registro FCM actualiza también metadatos `last_seen_at`, etiqueta y versión del cliente en `SyncDevice`.
- Las claves Redis OTP usan HMAC y el contador horario es atómico; el provider mock consume el código una sola vez.
- El guard global aplica buckets separados por usuario+dispositivo en rutas autenticadas.



### F-039 — Rotación de clave HMAC requiere estrategia de búsqueda dual

- **Prioridad:** moderado antes de rotar la clave de índice ciego.
- **Origen:** `User.phone_hmac` y otros índices guardan la versión de clave utilizada, pero el lookup inicial consulta el digest generado con la clave HMAC actualmente configurada.
- **Riesgo:** al sustituir la clave HMAC, los registros históricos seguirán teniendo digests de la clave anterior y el login por teléfono no los encontrará hasta migrarlos.
- **Estado:** no bloquea B1 con una única clave estable; identificado y registrado.
- **Acción requerida:** diseñar rotación con lookup temporal de versiones anteriores (o doble índice/versionado paralelo), reindexación por lotes y transición sin bloquear login. No cambiar la clave HMAC en producción hasta aprobar ese procedimiento.
- **Fase afectada:** operación de seguridad/cifrado, antes de la primera rotación de clave HMAC.

### F-040 — Proveedor OTP mock es local al proceso

- **Prioridad:** no tan urgente.
- **Origen:** el proveedor `MockOtpProvider` conserva challenges simulados en memoria del proceso; el registro de metadatos y TTL permanece en Redis.
- **Riesgo:** con varias réplicas API en desarrollo/pruebas, el código puede solicitarse a una réplica y verificarse en otra, o perderse al reiniciar el proceso.
- **Estado:** apropiado para Docker Compose local de una réplica y pruebas unitarias; producción no puede seleccionar este provider.
- **Acción requerida:** antes de usar varias réplicas de mock, mover el código simulado a un adapter respaldado por Redis/Test fixture compartido, sin cambiar el contrato HTTP.
- **Fase afectada:** entorno de pruebas distribuido, no producción.

## Correcciones adicionales aplicadas durante B1

- Las huellas de teléfono en claves Redis OTP ahora usan HMAC ciego con propósito separado; se retiró el SHA-256 sin clave.
- El contador horario de solicitudes OTP usa un script Lua atómico `INCR` + `EXPIRE`.
- El provider mock consume un challenge al aprobarlo y limpia challenges vencidos, evitando reuso para emitir sesiones múltiples.
- El rate limit global diferencia rutas públicas por IP y rutas autenticadas por usuario + dispositivo.
- La limpieza Redis posterior a una transacción de alta ya confirmada es best-effort: un fallo de limpieza no devuelve error falso después de haber creado una sesión; el proveedor OTP sigue impidiendo el reuso del challenge aprobado.

## Historial de revisión actualizado

| Fecha | Fase | Acción |
|---|---|---|
| 2026-11-03 | B1 | Añadidos F-027 a F-041; resueltas correcciones de OTP, rate limit e integración de identidad; exportación/eliminación integral de dominios futuros, IAM S3, KMS/Twilio reales, rotación HMAC, validación legal y ejecución de aceptación/medición de cobertura permanecen pendientes. |

## Hallazgos nuevos detectados durante B2

### Urgente

### F-048 — El contexto autenticado del cifrado no vincula ciphertext a la fila

- **Prioridad:** urgente antes de producción.
- **Origen:** `FieldCryptoService` usa AAD/EncryptionContext con aplicación, entorno y propósito del campo, pero no incluye identificador del usuario/registro. Las filas `Vehicle` cifran placa y VIN bajo propósitos fijos (`vehicles.plate` y `vehicles.vin`).
- **Riesgo:** alguien con capacidad de alterar filas en la base podría intercambiar pares de ciphertext + DEK cifrada entre registros del mismo propósito; el descifrado seguiría autenticando el propósito, pero no la identidad esperada de la fila.
- **Estado:** parcialmente resuelto durante B3. `FieldCryptoService` ahora admite AAD v2 que vincula `user_id` y `record_id` en AES-GCM y EncryptionContext KMS. Nuevas escrituras de placas/VIN y los campos sensibles de pólizas usan v2; `plate_aad_version`/`vin_aad_version` preservan compatibilidad v1 para registros existentes.
- **Pendiente:** los campos de identidad B1 (teléfono/email y metadatos de consentimiento) todavía usan AAD v1 porque no almacenan su versión/identificador de fila. El token FCM ya migró a AAD v2 en B4 mediante `token_aad_version`. Ejecutar re-cifrado gradual de esos campos y pruebas de intercambio contra una base con datos reales antes de producción.
- **Fase afectada:** seguridad/cifrado; aprobar diseño y migración antes de producción con datos reales.

### Moderado

### F-042 — El catálogo inicial de marcas/modelos no es exhaustivo

- **Prioridad:** moderado.
- **Origen:** B2 incluye un seed inicial de 11 marcas y 24 modelos comunes para permitir probar autocompletado desde desarrollo.
- **Riesgo:** conductores pueden tener vehículos de marcas/modelos no presentes en esa lista.
- **Estado:** mitigado a nivel funcional: el alta acepta `brand` y `model` como texto y los IDs del catálogo son opcionales; no se bloquea el registro por ausencia de una opción.
- **Acción requerida:** validar y ampliar el catálogo mediante fuentes/listas revisadas por el negocio antes de producción. No introducir marcas/modelos ficticios para aparentar cobertura.
- **Fase afectada:** catálogos / contenido de producción.

### F-043 — El resumen de vehículo es provisional hasta la fase de documentos

- **Prioridad:** moderado; esperado por dependencia de fase.
- **Origen:** B2 debe exponer `GET /vehicles/:id/summary`, pero `vehicle_documents` se crea en una fase posterior.
- **Riesgo:** antes de que exista B3, el endpoint devuelve `document_count: 0` y `next_expiration: null`, aunque el vehículo exista.
- **Estado:** resuelto durante B3: el resumen ahora consulta `vehicle_documents.valid_until` y cuenta solo documentos no eliminados.
- **Pendiente:** agregar pruebas de resumen con recordatorios cuando ese dominio exista.
- **Fase afectada:** B3 / recordatorios.

### F-044 — Limpieza de fotos de vehículo es best-effort y aún no tiene reconciliador

- **Prioridad:** moderado antes de producción.
- **Origen:** la API confirma el borrado lógico en PostgreSQL y luego intenta eliminar las keys de foto en S3. En la baja del vehículo, las keys actuales permanecen en el tombstone para permitir una futura reconciliación. En cambio, al reemplazar una foto confirmada o descartar una subida pendiente, la referencia anterior se sustituye antes de que finalice la limpieza.
- **Riesgo:** un fallo S3 durante el borrado o el reemplazo puede dejar un objeto huérfano sin referencia durable en PostgreSQL. Con versioning, `DeleteObject` puede dejar versiones recuperables. El log no constituye una cola persistente ni garantiza reintento.
- **Estado:** la limpieza es best-effort y no revierte una escritura ya confirmada en PostgreSQL. El evento de log ahora se denomina `storage_cleanup_failed_not_queued` para no sugerir que el objeto ya quedó encolado. La baja del vehículo sí conserva las keys en su tombstone; el reemplazo de fotos todavía no tiene outbox/registro de limpieza.
- **Acción requerida:** incorporar registro durable de objetos pendientes de eliminación (outbox/tabla de limpieza) o un worker idempotente con referencia persistida, incluyendo reemplazos y subidas pendientes. Gestionar versiones/delete markers según política de retención. No habilitar purga destructiva sin el flujo legal/de retención aprobado.
- **Fase afectada:** almacenamiento / workers de mantenimiento.

### F-045 — Formato de placa deliberadamente amplio requiere validación de producto

- **Prioridad:** moderado.
- **Origen:** B2 normaliza mayúsculas y elimina espacios, y valida 3–16 caracteres alfanuméricos o guion para no rechazar categorías vehiculares sin una especificación completa de placas entregada.
- **Riesgo:** el patrón puede aceptar combinaciones no emitidas o rechazar algún formato local excepcional si luego se endurece sin fuente.
- **Estado:** no se afirma que sea un validador oficial de placas de Nicaragua; la unicidad por usuario está protegida con HMAC.
- **Acción requerida:** confirmar ejemplos reales por categoría (moto, automóvil, transporte, placas especiales) con el propietario y fuente local fiable antes de restringir el patrón.
- **Fase afectada:** vehículos / validación de datos.

### No tan urgente

### F-046 — Fotografías todavía no pasan por análisis de contenido

- **Prioridad:** no tan urgente durante desarrollo; requerido revisar antes de abrir carga a producción.
- **Origen:** B2 valida MIME declarado, tamaño y metadata `HEAD` S3; no integra antivirus ni decodificación/re-encode para verificar contenido real.
- **Riesgo:** un archivo malformado o con contenido distinto al MIME declarado podría almacenarse como foto.
- **Estado:** alcance mínimo de B2; URLs y objetos siguen privados y solo propietarios autorizados obtienen descarga firmada.
- **Acción requerida:** valorar validación real de formato, límites de dimensiones y escaneo antes de publicar fotos; mantener tipos permitidos y bucket privado.
- **Fase afectada:** almacenamiento/fotos; antes de producción pública.

### F-047 — Validación integral automatizada queda para el cierre de todas las fases

- **Prioridad:** no tan urgente para continuar el desarrollo; ejecutar localmente antes del despliegue.
- **Origen:** se añadieron pruebas unitarias y de migración, pero el propietario indicó que la ejecución local y la validación de entornos se realizarán cuando estén implementadas todas las fases, para evitar interrupciones y ciclos de ejecución incompletos.
- **Riesgo:** no hay evidencia en este turno de que las pruebas, tipado, generación Prisma, build o migración pasen en el entorno local.
- **Estado:** la validación de B0–B5S queda pendiente intencionalmente; no se ejecutaron instalaciones, pruebas, cobertura, lint, generación Prisma, compilaciones, Docker ni conexiones a bases/servidores durante B5S.
- **Acción requerida:** al finalizar todas las fases, ejecutar en el equipo del propietario la instalación y generación del cliente Prisma, lint, pruebas unitarias/e2e/migraciones, build y validación de Compose/servicios según los scripts del repositorio. Resolver los hallazgos en conjunto, no fase por fase durante la implementación.
- **Fase afectada:** cierre integral del backend y CI.

## Historial de revisión actualizado

| Fecha | Fase | Acción |
|---|---|---|
| 2026-11-03 | B2 | Añadidos F-042 a F-048; captura manual de marca/modelo, resumen compatible con B3 y validación dinámica del año actual; limpieza S3, formato oficial de placas, análisis de fotos, contexto AAD de cifrado y validación local quedan registrados. |


## Hallazgos nuevos detectados durante B3

### Moderado

### F-049 — Catálogo de aseguradoras creado, pero sin datos iniciales verificados

- **Prioridad:** moderado.
- **Origen:** B3 implementa `Insurer`, versionado ETag y lectura pública; no se cargan nombres de aseguradoras sin una lista validada.
- **Riesgo:** el catálogo inicialmente puede devolver cero elementos y los usuarios deberán usar `other_insurer_name`.
- **Estado:** deliberado para evitar inventar operadores o nombres comerciales actuales.
- **Acción requerida:** proporcionar/validar una lista de aseguradoras habilitadas en Nicaragua y cargarla mediante seed revisado.
- **Fase afectada:** catálogos/operación de contenido.

### F-050 — Recordatorios todavía no existen para cancelar al borrar vehículo

- **Prioridad:** moderado, antes de B4/B5 de recordatorios.
- **Origen:** al eliminar un vehículo, B3 marca `VehicleDocument` e `InsurancePolicy` como borrados/archivados en la misma transacción. El modelo `Reminder` y su estado de cancelación aún no se han implementado.
- **Riesgo:** cuando se agreguen recordatorios, la baja de vehículo debe cancelar tareas programadas; hoy no existe una tabla/job durable que actualizar.
- **Estado:** resuelto en B4. El borrado lógico del vehículo cancela recordatorios `scheduled`/`processing` dentro de la misma transacción que elimina documentos y pólizas. Renovar póliza y editar documento también cancelan la agenda previa.
- **Acción requerida:** conservar esta coordinación en futuras mutaciones y pruebas de borrado.
- **Fase afectada:** B4.

### F-051 — Limpieza de objetos de documentos aún no tiene outbox durable

- **Prioridad:** moderado antes de producción.
- **Origen:** B3 mantiene keys privadas y estados en PostgreSQL; el borrado de vehículo oculta documentos y conserva las referencias S3, pero no existe worker durable para purga/reconciliación de esos objetos.
- **Riesgo:** los objetos privados pueden permanecer en S3 después de una eliminación lógica, según política de retención; no se pierden las referencias, pero la purga no es automática.
- **Estado:** los objetos no se eliminan de forma inmediata ni se pierden las keys; el flujo de retención/eliminación de cuenta debe incorporar estos prefijos.
- **Acción requerida:** agregar outbox/cola de limpieza y reconciliación con control de retención antes de producción.
- **Fase afectada:** storage cleanup / eliminación de cuenta.

### F-052 — Adaptador S3 simulado no puede verificar bytes reales

- **Prioridad:** no tan urgente para desarrollo; obligatorio mantener la restricción en producción.
- **Origen:** `S3_CLEANUP_MODE=mock` devuelve metadata simulada y no dispone de bytes para magic sniffing.
- **Riesgo:** los tests/dev pueden probar transición de estado, pero no simulan la validación de contenido real completa salvo mocks explícitos.
- **Estado:** producción rechaza `confirm` si no puede inspeccionar el objeto real; tests unitarios prueban firmas PDF y MIME inconsistente.
- **Acción requerida:** usar bucket de integración de pruebas o emulador compatible para prueba end-to-end del flujo S3; nunca permitir mock en producción.
- **Fase afectada:** pruebas de integración y despliegue.

## Historial de revisión actualizado

| Fecha | Fase | Acción |
|---|---|---|
| 2026-11-04 | B3 | Añadidos F-049 a F-054; F-048 pasa a parcialmente resuelto mediante AAD v2 compatible con datos v1; B3 incorpora documentos, pólizas, verificación de archivos y conservación de historial. |

### F-053 — Archivos privados sin análisis antimalware ni sanitización de PDF

- **Prioridad:** moderado antes de producción con documentos reales.
- **Origen:** B3 valida la firma mágica y MIME de PDF/JPEG/PNG/HEIC, tamaño y metadata S3, pero no ejecuta antivirus, desarme/reconstrucción de PDF ni decodificación completa de imágenes.
- **Riesgo:** un archivo con firma válida puede contener contenido activo o una carga maliciosa posterior al encabezado; el bucket es privado, pero un usuario autorizado puede descargarlo.
- **Estado:** no forma parte de los criterios mínimos B3 y no se habilita acceso público.
- **Acción requerida:** definir un proceso de cuarentena/escaneo antes de permitir descargas en producción, con estado de archivo adicional si la revisión requiere asincronía. Mantener la key privada y no marcar como disponible hasta superar la política que se apruebe.
- **Fase afectada:** almacenamiento/documentos y seguridad de producción.

### F-054 — Licencia de conducir modelada como documento de un vehículo

- **Prioridad:** moderado; validar antes de cerrar el diseño de documentos personales.
- **Origen:** la lista de tipos B3 incluye `licencia`, pero la tabla `vehicle_documents` y sus endpoints actuales requieren `vehicle_id`; conceptualmente una licencia de conducir pertenece al conductor, no a un vehículo específico.
- **Riesgo:** el usuario tendría que asociar artificialmente la misma licencia a uno de sus vehículos, y no podría conservarla si no tiene vehículo registrado.
- **Estado:** B3 conserva el alcance implementado (documentos bajo vehículo) para no cambiar el contrato de endpoints sin aprobación. Se documentó la discrepancia en `data-dictionary.md` y `offline-sync-contract.md`.
- **Acción requerida:** decidir si la licencia será un documento personal (`vehicle_id NULL` y rutas `/me/documents`) o si el producto realmente la quiere asociar a cada vehículo. Si se elige documento personal, ampliar FK, constraints, endpoints y reglas de sync en una migración compatible.
- **Fase afectada:** documentos/perfil y B5S.


## Revisión de hallazgos al cerrar B4

### F-048 — AAD v2 para campos de identidad: parcialmente resuelto

- **Prioridad:** urgente antes de producción.
- **Estado:** B4 amplía AAD v2 al token FCM: `device_tokens.token_aad_version` permite descifrado compatible con v1, y nuevas altas/rotaciones cifran con `user_id` + `device_token_id`. La API no registra tokens en logs y los elimina al invalidarlos/revocarlos.
- **Pendiente:** teléfono/email de `users` y metadatos cifrados de `consent_logs` siguen en AAD v1; requieren migración gradual con backfill y validación de integridad. No se realizó recifrado masivo sin una fase específica de migración.

### F-055 — Entrega externa FCM no ofrece exactly-once matemático

- **Prioridad:** moderado antes de producción.
- **Origen:** FCM no ofrece una transacción distribuida con PostgreSQL. Si FCM acepta el push y la conexión se pierde antes de persistir el ACK, no existe garantía absoluta de no duplicación.
- **Estado:** B4 reclama recordatorios con transición condicional, usa job IDs estables, log único por recordatorio/canal, no reenvía estado `sent`, recupera `processing` abandonados y envía collapse keys FCM.
- **Acción requerida:** monitorizar reintentos y duplicados residuales en producción; no anunciar exactly-once extremo a extremo.

### F-056 — Limpieza de objetos S3 de documentos continúa sin outbox durable

- **Prioridad:** moderado antes de producción.
- **Estado:** sin cambios en B4. Los documentos conservan keys en base y el flujo de eliminación de cuenta ejecuta limpieza; el borrado lógico de vehículo no elimina archivos de documentos.
- **Acción requerida:** implementar una outbox de limpieza S3 y reconciliador con retención aprobada antes de producción.

### F-057 — Credenciales FCM de producción deben configurarse fuera del repositorio

- **Prioridad:** moderado antes de activar push en producción.
- **Estado:** B4 exige `FCM_MODE=firebase`, `FIREBASE_PROJECT_ID` y `FIREBASE_SERVICE_ACCOUNT_BASE64`; desarrollo/test puede usar `FCM_MODE=mock`.
- **Acción requerida:** cargar el secreto desde el gestor de secretos del hosting y rotarlo; no guardar el JSON ni su Base64 en Git.

| Fecha | Fase | Acción |
|---|---|---|
| 2026-11-04 | B4/B5 | B4 agrega recordatorios y FCM; B5 agrega catálogos versionados, contactos cifrados y compartir por WhatsApp. Quedan F-048 parcial, F-051, F-053, F-055/F-056 y F-058/F-059/F-060 para seguimiento según su prioridad. |

### F-058 — Validación periódica de nombres y límites territoriales

- **Prioridad:** moderado.
- **Origen:** los seeds B5 representan los 15 departamentos y 2 regiones autónomas y 153 municipios con base en fuentes de INETER/MINSA disponibles. Los códigos de la aplicación son internos y no sustituyen los códigos oficiales completos.
- **Riesgo:** nombres, adscripciones municipales o límites pueden cambiar; no debe tratarse el catálogo seed como cartografía oficial ni como división catastral.
- **Estado:** cargado para uso funcional inicial con los 15 departamentos, las 2 regiones autónomas y 153 municipios previstos por la Ley 59. La ley también conserva disposiciones de adscripción administrativa provisional para ciertos municipios caribeños; el catálogo los agrupa según el listado principal del Artículo 6, no según la administración provisional.
- **Acción:** revisar la lista y las adscripciones contra la última capa descargable de INETER antes de producción y en cada actualización nacional. Si se necesita geofencing o asignación jurisdiccional de emergencias, incorporar geometrías y reglas territoriales oficiales en migración separada.
- **Fase afectada:** B5 / directorio / asistencia geográfica.

### F-059 — Catálogo de números de emergencia intencionalmente vacío

- **Prioridad:** moderado.
- **Origen:** no se proporcionó una fuente primaria con números actuales confirmados por categoría/cobertura.
- **Riesgo:** un número inventado, antiguo o de cobertura incorrecta puede impedir que una persona reciba ayuda.
- **Estado:** resuelto de forma preventiva: no hay números telefónicos en seeds; todos los registros creados por admin comienzan `verified=false`; la consulta pública solo muestra verificados.
- **Acción:** antes de cargar datos productivos, documentar institución, fuente oficial, ámbito territorial y fecha de verificación. Revalidar números periódicamente.
- **Fase afectada:** B5 / producción.

### F-060 — Datos personales del mensaje de WhatsApp

- **Prioridad:** no tan urgente.
- **Origen:** el mensaje de compartir incluye teléfono del usuario, nombre, vehículo y enlace con coordenadas suministradas por el cliente.
- **Riesgo:** al usar la URL de WhatsApp, esos datos pasan al sistema operativo y al servicio de destino cuando el usuario decide compartirlos.
- **Estado:** documentado; el API no persiste coordenadas ni envía el mensaje automáticamente y no incluye placa/VIN.
- **Acción:** la interfaz móvil debe mostrar una vista previa clara y pedir una acción explícita antes de abrir WhatsApp; no registrar `message` o `whatsapp_url` en analítica/logs.
- **Fase afectada:** integración Flutter.


## Revisión urgente posterior a B5 — 2026-11-04

### F-061 — El trigger de verificación de teléfonos de emergencia podía conservar una verificación obsoleta

- **Prioridad:** urgente.
- **Origen:** el trigger B5 permitía conservar `verified=true` cuando un `UPDATE` directo cambiaba el teléfono o el ámbito territorial, siempre que los metadatos antiguos de verificación siguieran presentes. Eso hacía posible saltarse la revalidación desde SQL, aunque el servicio NestJS sí la invalidaba.
- **Riesgo:** un número modificado podía seguir apareciendo como contacto de emergencia verificado con una fuente y una fecha que ya no correspondían al dato publicado.
- **Estado:** corregido en la migración incremental `20261104160000_emergency_verification_hardening`. Ahora cualquier cambio de teléfono, categoría, cobertura o procedencia invalida la verificación en PostgreSQL. El servicio realiza la revalidación explícita como un segundo `UPDATE` dentro de la misma transacción, después de la invalidación.
- **Validación añadida:** el script de migraciones comprueba cambios directos de teléfono y de URL de procedencia, y la prueba unitaria comprueba la revalidación administrativa de dos pasos.
- **Compatibilidad:** no se modifica la migración B5 ya publicada; se agrega una migración forward-only con `rollback.sql` para entornos de prueba. No ejecutar rollback manual en producción.

### F-062 — El cursor incremental usa una ventana finita para commits fuera de orden

- **Prioridad:** moderado antes de producción.
- **Origen:** B5S reconsulta una ventana de 5,000 versiones de la secuencia global para recuperar transacciones que confirmen fuera de orden.
- **Riesgo:** una transacción que permanezca abierta más tiempo que la ventana puede confirmar con una versión anterior al piso consultado y no aparecer en pulls posteriores.
- **Estado:** limitación explícita de D-062; el cliente deduplica por entidad/ID/versión y el backend no presenta la ventana como garantía absoluta.
- **Acción requerida:** antes de producción, instrumentar duración de transacciones y revisar la ventana con carga/concurrencia real; evaluar un watermark basado en commits si el perfil operativo lo requiere.
- **Fase afectada:** B5S / operación de sincronización.

### F-063 — Limpieza de registros técnicos de sincronización no automatizada

- **Prioridad:** moderado antes de producción.
- **Origen:** B5S conserva `ProcessedMutation` durante al menos 180 días y los snapshots de bootstrap expiran en 24 horas; los snapshots vencidos se limpian oportunistamente al comenzar otro bootstrap del mismo dispositivo.
- **Riesgo:** dispositivos que no vuelvan a iniciar bootstrap pueden dejar snapshots vencidos, y los resultados idempotentes crecerán sin un proceso de retención posterior.
- **Estado:** no se instala un job de purga en esta fase para evitar eliminar evidencia necesaria antes de aprobar la política de retención.
- **Acción requerida:** definir y desplegar una tarea privilegiada de limpieza con límites de retención aprobados, métricas y borrado por lotes; nunca otorgar permisos de purga al proceso HTTP.
- **Fase afectada:** mantenimiento/operación B5S.

## Historial de revisión actualizado

| Fecha | Fase | Acción |
|---|---|---|
| 2026-11-09 | B5S | Implementados bootstrap/pull/push/status, cursor por dispositivo/canal, idempotencia cifrada, migración y contratos. F-062 documenta la ventana finita y F-063 la limpieza técnica futura. La validación local/integral se pospone hasta cerrar todas las fases por instrucción del propietario. |
