# Contrato B1 — autenticación, identidad y privacidad

**Versión:** 1.0.0
**Prefijo:** `/api/v1`
**Zona horaria:** instantes UTC; reglas locales `America/Managua`.

Este contrato describe los endpoints implementados en B1. Todas las respuestas y errores usan JSON. Los errores conservan el formato uniforme `{ "code", "message", "details", "request_id" }` y mensajes en español.

## 1. Reglas generales

- El teléfono se recibe normalizado en formato E.164 de Nicaragua: `+505` seguido de exactamente ocho dígitos.
- OTP se entrega por SMS o WhatsApp mediante Twilio Verify en producción. El proveedor simulado solo funciona en `development` y `test`; la configuración rechaza `OTP_MODE=mock` en `production`.
- La versión de consentimiento requerida es la configurada en `CONSENT_POLICY_VERSION`. Para crear una cuenta se exige `accepted: true` y coincidencia exacta de versión antes de invocar la verificación OTP y antes de crear la identidad.
- La aplicación genera un UUID v7 por instalación como `device_id` antes de verificar OTP. El servidor lo valida y crea el registro `SyncDevice` dentro de la misma transacción que registra la cuenta/sesión.
- El mismo `device_id` no puede pertenecer a dos cuentas. Para cambiar de cuenta en una misma instalación se debe generar un nuevo `device_id`.
- Access y refresh JWT usan HS256, secretos distintos, `issuer=vehicular-api` y `audience=vehicular-mobile`. El access token vive 900 segundos por defecto; el refresh dura 30 días por defecto.
- El backend almacena solo SHA-256 del refresh token, nunca el JWT en claro. El refresh token está ligado a un `device_id` y a una `family_id`.
- Un evento `ConsentLog` es server-only y append-only. IP y User-Agent, cuando están disponibles, se cifran en la aplicación. En la eliminación de cuenta se permite anonimizar únicamente esos valores cifrados.
- En logout, reutilización de refresh o eliminación/revocación remota, los tokens FCM asociados se invalidan y se borran sus datos cifrados.

## 2. Solicitar OTP

`POST /api/v1/auth/otp/request` — público, `200 OK`.

Request:

```json
{
  "phone": "+50588881234",
  "channel": "whatsapp"
}
```

`channel` acepta `sms` o `whatsapp`.

Response de producción:

```json
{
  "message": "Si el número puede recibir mensajes, se enviará un código por whatsapp.",
  "channel": "whatsapp",
  "expires_in_seconds": 300
}
```

En `development`/`test` con `OTP_MODE=mock`, la respuesta añade `debug_code`. El proveedor mock mantiene un challenge temporal de un solo uso y lo elimina al aprobarlo. Este campo no se emite en modo Twilio y no puede activarse en producción.

Validación y límites:

- máximo inicial configurable `OTP_MAX_REQUESTS_PER_HOUR=5` por número normalizado; la clave Redis se deriva mediante HMAC ciego (no SHA-256 sin clave), y el contador horario usa un script Lua atómico `INCR` + `EXPIRE`;
- solicitud rechazada mientras exista bloqueo temporal;
- duración de challenge inicial `OTP_CODE_TTL_SECONDS=300`;
- fallos acumulados: máximo exactamente cinco por número durante la ventana configurada; reenviar OTP no reinicia ese contador;
- tras el quinto fallo se bloquea durante `OTP_LOCK_MINUTES=15`.

Errores principales: `VALIDATION_ERROR`, `OTP_TEMPORARILY_BLOCKED` (429), `OTP_REQUEST_LIMIT_EXCEEDED` (429), `OTP_PROVIDER_NOT_CONFIGURED` (503), `OTP_PROVIDER_UNAVAILABLE` (503), `OTP_PROVIDER_ERROR` (503), `RATE_LIMIT_STORE_UNAVAILABLE` (503).

## 3. Verificar OTP y crear sesión

`POST /api/v1/auth/otp/verify` — público, `200 OK`.

Request:

```json
{
  "phone": "+50588881234",
  "code": "123456",
  "device_id": "018bcfe5-6800-7abc-8def-0123456789ab",
  "platform": "android",
  "device_label": "Pixel 9",
  "app_version": "1.0.0",
  "display_name": "Nombre visible",
  "consent": {
    "policy_version": "privacy-2026-11-v1",
    "accepted": true
  }
}
```

`device_id` debe ser UUID v7; `platform` es `android` o `ios`. `consent` es obligatorio cuando no existe una identidad activa con la versión de política ya aceptada. Para alta nueva siempre es obligatorio.

Flujo transaccional:

1. Verificar que exista un challenge no vencido y que el número no esté bloqueado.
2. Confirmar consentimiento vigente antes de pedir aprobación al proveedor OTP.
3. Verificar el código con Twilio Verify o el proveedor mock permitido.
4. Buscar o crear `User`; el ID de la cuenta lo genera el backend (UUID v7). El cliente nunca elige ID, rol ni estado.
5. Crear o actualizar `SyncDevice` con el UUID v7 enviado por el cliente; rechazar si pertenece a otra cuenta.
6. Registrar `ConsentLog` cuando corresponde, incluyendo versión exacta y `received_at` del servidor.
7. Crear refresh token de la familia y emitir el par JWT. La transacción no deja un usuario creado sin su dispositivo, consentimiento requerido y sesión persistida.

Response:

```json
{
  "tokens": {
    "access_token": "<jwt>",
    "refresh_token": "<jwt>",
    "token_type": "Bearer",
    "expires_in": 900,
    "refresh_expires_in": 2592000
  },
  "is_new_user": true,
  "user": {
    "id": "<uuid-v7-servidor>",
    "phone": "+50588881234",
    "display_name": "Nombre visible",
    "role": "user",
    "created_at": "2026-11-03T16:00:00.000Z"
  }
}
```

Errores principales: `CONSENT_REQUIRED` (403), `CONSENT_VERSION_MISMATCH` (403), `OTP_EXPIRED` (401), `OTP_INVALID` (401, incluye `attempts_remaining`), `OTP_TEMPORARILY_BLOCKED` (429), `DEVICE_ID_IN_USE` (409), `ACCOUNT_DELETION_PENDING` (409), `ACCOUNT_SUSPENDED` (403), `PHONE_ALREADY_REGISTERED` (409).

## 4. Rotar refresh token

`POST /api/v1/auth/refresh` — público respecto a access JWT, pero requiere un refresh JWT válido en el cuerpo; `200 OK`.

Request:

```json
{ "refresh_token": "<refresh-jwt-actual>" }
```

Response: mismo esquema `tokens` del alta/login.

La rotación bloquea la fila del hash del token (`SELECT ... FOR UPDATE`), crea el nuevo refresh token de la misma familia y revoca el anterior en la misma transacción. El refresh token anterior no puede volver a utilizarse.

Si se detecta reutilización de un token consumido, se revoca toda la familia, se desactiva el dispositivo y sus tokens FCM y se responde `401 LOCAL_DATA_PURGE_REQUIRED` con `details.purge_local_data=true`.

Errores: `AUTH_REQUIRED` (401), `LOCAL_DATA_PURGE_REQUIRED` (401), `ACCOUNT_SUSPENDED` (403).

## 5. Cerrar sesión

`POST /api/v1/auth/logout` — `204 No Content`.

Request:

```json
{ "refresh_token": "<refresh-jwt>" }
```

Revoca la familia asociada, el `SyncDevice` y los tokens FCM del dispositivo. Es idempotente frente a un token desconocido ya revocado: no revela si el hash existe. El cliente debe borrar de inmediato los JWT, SQLite cifrado y archivos privados locales al cerrar sesión.

## 6. Perfil autenticado

### `GET /api/v1/me`

Requiere `Authorization: Bearer <access_token>`. Devuelve perfil propio: `id`, `phone`, `display_name`, `email`, `role`, `status`, `phone_verified_at`, `created_at`, `updated_at`.

### `PATCH /api/v1/me`

Permite `display_name` y/o `email`. No permite cambiar teléfono, rol, estado ni IDs. Un body sin campos editables devuelve `400 EMPTY_PROFILE_UPDATE`. Un correo repetido devuelve `409 EMAIL_ALREADY_IN_USE`.

**Importante:** B1 no verifica la propiedad del correo electrónico. El email se trata como dato de perfil no verificado y no debe utilizarse para recuperar cuenta ni como factor de seguridad hasta que exista un flujo de verificación independiente.

## 7. Registrar token FCM del dispositivo

`POST /api/v1/me/devices` — `200 OK` (operación de registro/rotación idempotente por token).

Request:

```json
{
  "device_id": "018bcfe5-6800-7abc-8def-0123456789ab",
  "platform": "android",
  "fcm_token": "<token-fcm-del-dispositivo>",
  "device_label": "Pixel 9",
  "app_version": "1.0.0"
}
```

El `device_id` y `platform` deben coincidir con la sesión y con `SyncDevice`. El FCM token se cifra AES-256-GCM y se indexa mediante HMAC ciego dedicado. El valor claro nunca se devuelve. Registrar un nuevo token revoca y elimina el anterior de ese mismo dispositivo.

Errores: `DEVICE_MISMATCH` (403), `DEVICE_NOT_FOUND` (404), `DEVICE_PLATFORM_MISMATCH` (409), `FCM_TOKEN_ALREADY_REGISTERED` (409).

Response:

```json
{
  "device_id": "018bcfe5-6800-7abc-8def-0123456789ab",
  "platform": "android",
  "registered_at": "2026-11-03T16:00:00.000Z",
  "status": "active"
}
```

## 8. Exportar datos propios

`GET /api/v1/me/export` — requiere bearer token, `200 OK`.

Devuelve JSON `format_version=1.0` con `profile`, eventos de consentimiento (incluyendo IP/User-Agent descifrados solo para la exportación autorizada, si se conservaron) y metadatos de dispositivos. Nunca devuelve access/refresh tokens ni el token FCM en claro.

En B1 el export cubre únicamente identidad, consentimiento y dispositivos. Vehículos, documentos, pólizas, asistencia, reseñas y demás dominios deben incorporar sus propios export handlers en sus fases antes de afirmar que la exportación integral del producto está completa.

## 9. Eliminar cuenta

`DELETE /api/v1/me` — requiere access token, `200 OK`.

No elimina filas físicamente en B1. El flujo:

1. Cambia `User.status` a `deletion_pending` y revoca inmediatamente refresh tokens y tokens FCM, impidiendo nuevas sesiones y notificaciones.
2. Elimina versiones y delete markers de S3 en los prefijos `users/{user_id}/` y `exports/{user_id}/`.
3. Si S3 falla, conserva `deletion_pending`, no reactiva sesiones y devuelve `503 ACCOUNT_DELETION_PENDING`; el usuario puede repetir `DELETE /me` con su access token aún válido para completar el paso.
4. Al completar S3, revoca `SyncDevice`, anonimiza columnas cifradas de IP/User-Agent de `ConsentLog`, elimina criptográficamente teléfono/email e índices ciegos de `User`, cambia display name a `Cuenta eliminada` y marca `deleted_at`.
5. Devuelve `local_cleanup_code=LOCAL_DATA_PURGE_REQUIRED`.

Respuesta:

```json
{
  "status": "deleted",
  "files_cleanup": "deleted",
  "local_cleanup_code": "LOCAL_DATA_PURGE_REQUIRED",
  "message": "La cuenta fue eliminada y las sesiones y dispositivos quedaron invalidados. Borra todos los datos privados locales."
}
```

Cualquier petición posterior firmada con un access/refresh JWT verificable de esa cuenta/dispositivo devuelve `401 LOCAL_DATA_PURGE_REQUIRED`, incluso si el JWT expiró, para que el cliente limpie SQLite, archivos, caché, colas y tokens. Los JWT con firma inválida devuelven `AUTH_REQUIRED` porque no se puede confiar en su identidad.

**Alcance B1:** como las tablas de vehículos/documentos, asistencia, negocios, facturación y demás dominios aún no existen, B1 solo elimina/anonymiza identidad y los prefijos S3 de archivos personales/exportaciones. Cada dominio futuro debe registrar sus políticas de borrado, exportación y retención antes de producción. Toda interpretación sobre plazos/obligaciones de la Ley 787 debe marcarse “validar con abogado local”.

## 10. Estados y códigos de error comunes

| Código | HTTP | Significado / acción cliente |
|---|---:|---|
| `AUTH_REQUIRED` | 401 | Token inválido o expirado para cuenta/dispositivo activo; renovar sesión o pedir OTP. |
| `LOCAL_DATA_PURGE_REQUIRED` | 401 | Borrar todos los datos privados locales, tokens, cachés y archivos. |
| `CONSENT_REQUIRED` | 403 | Mostrar política vigente y solicitar aceptación explícita. |
| `CONSENT_VERSION_MISMATCH` | 403 | Descargar/mostrar la versión actual y volver a solicitar aceptación. |
| `OTP_EXPIRED` | 401 | Pedir un OTP nuevo. |
| `OTP_INVALID` | 401 | Código incorrecto; respetar `attempts_remaining`. |
| `OTP_TEMPORARILY_BLOCKED` | 429 | No reintentar hasta finalizar `lock_minutes`. |
| `OTP_REQUEST_LIMIT_EXCEEDED` | 429 | Esperar `retry_after_seconds`. |
| `DEVICE_ID_IN_USE` | 409 | Crear un nuevo UUID v7 de instalación antes de cambiar de cuenta. |
| `ACCOUNT_DELETION_PENDING` | 503/409 | Reintentar DELETE /me; no restaurar sesión ni datos locales. |
| `ACCOUNT_SUSPENDED` | 403 | No reintentar en bucle; mostrar estado de cuenta. |

El filtro global añade `request_id`. El rate limit global usa IP+método+ruta en endpoints públicos y usuario+dispositivo+método+ruta en endpoints autenticados; OTP añade cuota por teléfono mediante HMAC. Los mensajes de negocio son en español y los detalles no exponen datos de otra cuenta.
