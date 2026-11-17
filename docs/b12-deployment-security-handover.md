# B12 — seguridad, operación y entrega

## Estado de seguridad

- Se aplican cabeceras Helmet: CSP, `X-Content-Type-Options`, protección contra framing, referrer policy y otras cabeceras seguras. El proxy de borde debe terminar TLS y publicar HSTS; la API no confía en `X-Forwarded-*` por defecto.
- La API mantiene CORS por allowlist, DTOs con whitelist estricta, roles y propiedad por consulta. PostgreSQL usa `app_runtime` para la API y `app_migrator` solo para migraciones. Runtime no tiene `DELETE`, DDL ni secuencias globales; la migración B10 concede únicamente `USAGE` sobre la secuencia de facturas que necesita.
- No se registran bodies, query strings, tokens de enlaces de acción, teléfonos ni errores/stack traces en logs de aplicación. `request_id` se devuelve como `X-Request-Id`, aparece en logs y se adjunta a errores Sentry. Sentry no captura PII, cuerpos, headers, query strings, datos SQL ni argumentos de cola; configura `SENTRY_DSN` para activarlo. Sin DSN, la aplicación sigue funcionando sin enviar telemetría.
- El repositorio usa `npm ci` y conserva `package-lock.json`. La auditoría de npm al 17-11-2026 reportó 38 avisos **moderados**, 0 altos y 0 críticos en el árbol completo. CI bloquea hallazgos altos/críticos (`npm audit --audit-level=high`). El reporte incluye dependencias de desarrollo; revisar los moderados en cada actualización.
- No se encontraron archivos `.env` versionados. `.env.example` solo incluye valores de desarrollo y debe copiarse a `.env`; producción requiere secretos distintos desde el gestor de secretos, cifrado KMS, TLS de PostgreSQL/Redis, Twilio y FCM configurados.

## Inicio local desde cero

Requisitos: Node 22.16+, Docker Compose v2 y Git.

```bash
cp .env.example .env
docker compose up -d db redis
npm ci
npm run prisma:generate
docker compose --profile tools run --rm migrate
npm run build
npm run start:dev
```

El Compose local crea PostgreSQL/PostGIS, Redis con contraseña y roles separados. La migración nunca debe ejecutarse con `DATABASE_URL` de `app_runtime`. `/health` valida API, BD y Redis. Swagger está en `/docs`; el documento OpenAPI JSON está en `/docs-json`.

## Producción y despliegue automatizado

La imagen se publica con tag inmutable `ghcr.io/OWNER/REPO:<commit>`. En GitHub, habilitar variable `DEPLOY_ENABLED=true` y definir secretos `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PATH`, `DEPLOY_SSH_PRIVATE_KEY` y `DEPLOY_SSH_KNOWN_HOSTS`. La huella SSH debe verificarse fuera de GitHub Actions y guardarse como known-hosts. El host debe tener Docker Compose, una copia del repositorio y login de solo lectura a GHCR para paquetes privados. Mantener `.env` en `/etc/vehicular/.env` o en el directorio protegido del servicio, nunca dentro de Git.

El workflow construye/publica la imagen; `scripts/deploy-compose.sh` descarga la imagen fijada por SHA, aplica migraciones con `app_migrator`, actualiza la API y exige `/health` antes de considerar el despliegue sano. El frontend debe tener origen explícito en `CORS_ORIGINS`. Configurar TLS/HSTS en el proxy, límites de conexiones, firewall y alertas del proveedor de infraestructura.

Permisos mínimos recomendados:

- PostgreSQL: API solo como `app_runtime`; deploy usa `app_migrator`; backups usan un usuario `pg_dump` de solo lectura con acceso a esquema/tabla requerido. No usar `postgres` para la aplicación.
- S3: bucket privado, sin ACL públicas, bloqueo de acceso público, TLS obligatorio y lifecycle de respaldos según `deploy/s3-lifecycle.json`. API solo opera prefijos de archivos que necesita; backup role solo escribe/lee el prefijo de backup. KMS limita Encrypt/Decrypt al rol API/backup necesario.
- Sentry: solo DSN del proyecto backend; no poner auth token de administración en el runtime.

## Backup y simulacro de restauración

`deploy/systemd/vehicular-backup.timer` programa un backup diario a las 02:15 UTC. Instalar el servicio/timer en el host, proporcionar `/etc/vehicular/backup.env` con `DATABASE_URL` de respaldo, `BACKUP_S3_URI`, `BACKUP_KMS_KEY_ID` y credenciales AWS de rol de instancia; restringir el archivo a `root`/usuario de backup. El script crea un dump custom, valida su índice con `pg_restore --list`, calcula SHA-256 y sube con SSE-KMS. Aplicar `deploy/s3-lifecycle.json` al bucket para retener 90 días y habilitar versionado/Object Lock según política de continuidad.

Simulacro periódico en una base PostgreSQL vacía y desechable (no producción):

```bash
RESTORE_DATABASE_URL='postgresql://restore_role:...@restore-host/vehicular_restore?schema=public' \
  bash scripts/restore-drill.sh s3://private-bucket/vehicular/postgres/vehicular-<timestamp>.dump
```

El script descarga, valida y restaura el dump, y verifica tablas críticas. Registrar fecha, backup, duración, tamaño, resultado y persona responsable en el registro de continuidad. **La restauración no se pudo ejecutar en este entorno**: no está instalado Docker/PostgreSQL cliente y no hay credenciales/bucket S3 conectado.

## Rendimiento k6

`test/performance/b12-backend.k6.js` carga búsqueda, anuncios, sync pull/push y el worker real de recordatorios. Requiere API/Redis/PostgreSQL de staging, usuarios/token de prueba y fixture seguro: `API_BASE_URL`, `SYNC_ACCESS_TOKEN`, `SYNC_DEVICE_ID`, `SYNC_CURSOR`, `SYNC_PUSH_BODY_JSON`, `ADMIN_ACCESS_TOKEN`, `DEPARTMENT_ID`. Preparar filas de recordatorio vencidas con usuarios/dispositivos de prueba, sin destinos reales; el endpoint administrativo de despacho existe solo con `NODE_ENV=test` y encola una fila por iteración. Usar `FCM_MODE=mock` y limpiar las filas/colas al terminar.

```bash
k6 run -e API_BASE_URL=https://staging.example/api/v1 \
  -e SYNC_ACCESS_TOKEN='...' -e SYNC_DEVICE_ID='...' -e SYNC_CURSOR='...' \
  -e SYNC_PUSH_BODY_JSON='{"device_id":"...","mutations":[...]}' \
  -e ADMIN_ACCESS_TOKEN='...' -e DEPARTMENT_ID='...' \
  test/performance/b12-backend.k6.js
```

Los umbrales son búsqueda p95 <300 ms, sync pull p95 <500 ms, worker p95 <5 s y errores HTTP <1%. Anuncios se comprueban por HTTP 200 y etiqueta `patrocinado: true`. **No se ejecutó k6 aquí** porque no hay binario k6 ni entorno de prueba levantado; esos p95 todavía no están acreditados.

## OpenAPI y cliente del frontend

Swagger genera el esquema desde los DTOs/controladores Nest: `GET /docs-json`. Con el backend y sus dependencias levantadas, generar tipos con:

```bash
OPENAPI_URL=http://localhost:3000/docs-json npm run openapi:types
```

El archivo `src/api/client.ts` envuelve `openapi-fetch`; el frontend pasa el `paths` generado para tipar rutas, query, body y respuesta. Exportar el JSON para inspección con `curl http://localhost:3000/docs-json -o openapi.json`.

## Contrato offline final

El conductor sincroniza únicamente dominios B1–B5S. B6–B11 (directorio, asistencia del proveedor, reseñas, publicidad, pagos, reclamaciones de negocio, administración y auditoría) son online-only y nunca se replican a dispositivo ni aceptan escritura por `/sync/push`. Cursores opacos, idempotencia, tombstones, ventanas y códigos vigentes permanecen en `docs/offline-sync-contract.md`.

## Limitaciones verificables de esta entrega

- La auditoría npm mostró cero hallazgos altos/críticos, pero sí 38 moderados en dependencias directas/transitivas. La aceptación literal de “sin vulnerabilidades críticas ni altas” pasa; los moderados quedan documentados.
- El entorno de trabajo no dispone de `docker` ni `k6`; no es posible validar p95, ejecutar Testcontainers ni completar restauración real aquí.
- La compilación actual arrastra 71 errores preexistentes en otros módulos del backend. Ejecutar CI en el entorno de desarrollo actualizado y cerrar esos fallos antes de etiquetar una release.
- La salida OpenAPI tipada se genera contra la instancia en ejecución; en este entorno no pudo materializarse porque la API depende de PostgreSQL/Redis no disponibles.
