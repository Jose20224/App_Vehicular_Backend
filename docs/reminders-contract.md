# Contrato B4 — recordatorios y notificaciones

**Zona horaria de negocio:** `America/Managua`. PostgreSQL almacena instantes UTC.

## Programación automática

Cuando se crea o edita un `VehicleDocument` con `valid_until`, o se registra/renueva una póliza, el servidor genera recordatorios en los offsets habilitados `[30, 15, 7, 1, 0]`. La hora inicial es `09:00` local. Los instantes anteriores al momento actual no se generan. Un vencimiento a 31 días crea el primer recordatorio para el día siguiente.

El texto se prepara en el servidor, por ejemplo: `Tu seguro del Honda CB vence en 7 días.` Para offset cero se utiliza `vence hoy`. Al cambiar la fecha, cambiar preferencias o renovar una póliza, los recordatorios anteriores aún pendientes/en proceso se marcan `cancelled` y se generan los nuevos dentro de la misma transacción que la mutación del documento/póliza/preferencia. Los registros enviados se conservan como historial.

`Reminder` contiene UUID v7, `user_id`, `vehicle_document_id`, `due_at`, `scheduled_at`, `lead_time_days`, `channel`, estado, intentos, marcas de envío/cancelación y metadatos `sync_version`. Es de escritura exclusiva del servidor y lectura desde `/sync/pull`/API; el cliente móvil no puede mutar recordatorios ni su estado. `NotificationPreference` es sync-ready y permite offsets, hora preferida y canales push/local/in-app.

## Worker y entrega

PostgreSQL es la fuente de verdad. BullMQ usa Redis para ejecutar un dispatcher repetido cada minuto y jobs individuales con ID estable `reminder-{uuid}`, seis intentos y backoff exponencial de 30 segundos. El worker reclama atómicamente `scheduled -> processing`; los registros `sent` no se reenvían tras reinicio. Los registros `processing` abandonados por una caída se recuperan tras 10 minutos. Se utiliza un collapse key derivado del ID para reducir duplicados de transporte en FCM.

La entrega a un proveedor externo no puede ofrecer una garantía matemática de exactly-once si el proveedor acepta el push y la conexión se pierde antes de que la API persista la respuesta. La API mantiene idempotencia persistente, log único por recordatorio/canal y collapse key; la ventana residual se clasifica como moderada y debe vigilarse en producción.

Tokens FCM se descifran solo en memoria, nunca se registran en logs. Respuestas FCM de token no registrado/inválido provocan revocación y borrado del ciphertext/hash del token. Errores transitorios se reintentan con backoff.

## Endpoints

- `GET /api/v1/reminders/schedule`: próximos 90 días, solo recordatorios futuros, con `id`, `document_id`, `scheduled_at`, `title`, `body` y `lead_time_days`. Si `local_enabled=false`, devuelve una agenda vacía.
- `GET /api/v1/me/notification-preferences`: preferencias efectivas; crea defaults si todavía no existen.
- `PATCH /api/v1/me/notification-preferences`: `enabled_offsets`, `preferred_time`, `push_enabled`, `local_enabled`, `in_app_enabled`.
- `GET /api/v1/notifications?limit=50`: historial propio, máximo 100.
- `PATCH /api/v1/notifications/:id/read`: marca como leído un evento propio.
- `PATCH /api/v1/documents/:id`: editar título/emisor/vigencia y reemplazar programación.

La aplicación móvil programa notificaciones locales desde `GET /reminders/schedule`; son una proyección offline y no se consideran confirmación de entrega del servidor.

## Configuración FCM

- Desarrollo/pruebas: `FCM_MODE=mock` (por defecto fuera de producción).
- Producción: `FCM_MODE=firebase`, `FIREBASE_PROJECT_ID` y `FIREBASE_SERVICE_ACCOUNT_BASE64` con JSON de cuenta de servicio codificado en Base64. No almacenar el JSON de credenciales en el repositorio.
