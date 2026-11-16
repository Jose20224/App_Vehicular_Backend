# B7 — Proveedores y solicitudes de asistencia en carretera

**Estado:** implementación incorporada sobre B6/B5S; despliegue de migración y validación contra PostgreSQL/Redis/Twilio pendientes.  
**Stack:** NestJS, Prisma, PostgreSQL 16 + PostGIS, Redis + BullMQ, adaptador simulado o Twilio.  
**Zona horaria:** `America/Managua`; timestamps persistidos en UTC.

## 1. Decisiones de integración

- `AssistanceProvider` completa el ancla relacional B6. Conserva propietario y tipo de servicio, cifra teléfono y WhatsApp con AES-256-GCM/AAD v2, y registra `coverage_area` como `geometry(MultiPolygon,4326)` con GiST.
- La ficha solo se publica después de la verificación administrativa. Publicar requiere ubicación base, polígono válido, referencia de texto y teléfono cifrado. Cambios de contacto, cobertura, coordenadas, referencia o territorio revocan la verificación y devuelven la ficha a revisión.
- Los proveedores **no se incluyen en la réplica offline del conductor** ni se exponen en `/sync/push`. El teléfono aparece en el paquete de emergencia temporal y en búsquedas online.
- `AssistanceRequest` sí se conserva como entidad sync-ready del solicitante. Flutter crea el UUID v7 y estado local `pending_envio`; al llegar al servidor se persiste como `created`. El servidor nunca acepta del móvil el proveedor asignado ni las transiciones operativas.
- No existe flujo de cobro ni pago para conductores. La respuesta solo incluye `price_estimate` y el texto legal exacto cuando haya una oferta publicada.

## 2. Estados

El servidor almacena únicamente:

`created → sent → accepted → en_camino → completed`

Desde `sent`, `accepted` o `en_camino` se permite `cancelled` según las reglas de transición. El conductor puede cancelar desde `created` o `sent`; el proveedor usa enlaces de acción desde `sent` y luego recibe nuevos enlaces al confirmar `accepted` o `en_camino`. Los enlaces hermanos se invalidan cuando uno se consume.

`pending_envio` es exclusivamente local: no significa que el servidor haya recibido la solicitud ni que se haya avisado a alguien. La notificación no reemplaza llamada/WhatsApp directa desde los contactos de emergencia.

## 3. Endpoints

Base `/api/v1`.

| Método | Ruta | Acceso | Uso |
|---|---|---|---|
| `GET` | `/assistance-providers/search?lat=&lng=&service_type_id=&radius_meters=&limit=` | Público | Proveedores cuya cobertura contiene el punto y cuya base está dentro del radio. Orden disponible, 24 h, distancia. |
| `GET` | `/assistance-providers/offline-emergency-package?lat=&lng=&radius_meters=&limit=` | Público | Paquete compacto por zona; máximo menos de 100 KB (99.999 bytes); cache del servidor corto; el cliente aplica TTL de siete días. |
| `POST` | `/assistance-providers` | `provider_owner` | Crear ficha `draft` con contactos cifrados y GeoJSON. |
| `PATCH` | `/assistance-providers/:id` | `provider_owner` | Editar ficha; los cambios críticos requieren nueva verificación. |
| `POST` | `/assistance-providers/:id/submit-verification` | `provider_owner` | Enviar perfil completo a revisión. |
| `PATCH` | `/admin/assistance-providers/:id/status` | `admin` | Activar, suspender o devolver a revisión. |
| `POST` | `/assistance-requests` | `user` | Crear solicitud online, idempotente por UUID v7. |
| `GET` | `/assistance-requests/mine` | `user` | Historial paginado propio. |
| `GET` | `/assistance-requests/mine/:id` | `user` | Detalle propio con GPS y eventos. |
| `POST` | `/assistance-requests/mine/:id/cancel` | `user` | Cancelar desde la app en estados permitidos. |
| `GET` | `/assistance-actions/:token` | Token bearer | Previsualizar el cambio sin consumirlo. |
| `POST` | `/assistance-actions/:token/confirm` | Token bearer | Confirmar y consumir una vez el enlace. |

La ruta de paquete necesita coordenadas válidas. La búsqueda exige `lat` y `lng` juntos. `radius_meters` acepta 100–100 000 (default 25 000); `limit` 1–50 (default 20).

## 4. Búsqueda y precios

PostGIS usa `ST_Covers(coverage_area, point)` para incluir también puntos en el borde del polígono. `ST_DWithin(base_location::geography, point::geography, radius)` reduce candidatos usando GiST; `ST_Distance` ordena los resultados. Se excluyen fichas no verificadas, suspendidas, eliminadas o con disponibilidad `unavailable`.

La búsqueda devuelve datos de llamada (`tel:`) y WhatsApp (`https://wa.me/`) solo si el contacto correspondiente existe. Los contactos se descifran únicamente después de seleccionar los resultados visibles.

Los precios proceden de `ServiceOffering` publicada y activa, moneda USD. Se presenta mínimo/máximo como estimación, no como cobro de la app. Toda respuesta con precio incluye literalmente:

> Precio estimado. El pago se realiza directamente al taller o al proveedor cuando se presta el servicio.

Los precios con más de 90 días se etiquetan `desactualizado`. No se devuelven importes en historial de solicitudes ni en el paquete offline.

## 5. Paquete offline de emergencia

La respuesta contiene `generated_at`, `expires_at`, `ttl_seconds=604800`, centro, radio, contactos públicos de proveedores verificados, números de emergencia oficiales verificados y `size_bytes`. Se limita estrictamente a menos de 100 KB (99.999 bytes) eliminando del final los proveedores más lejanos; si solo los datos oficiales exceden el límite, la API responde `OFFLINE_PACKAGE_TOO_LARGE` y no trunca silenciosamente números oficiales.

El móvil debe almacenar el paquete con `generated_at` y aplicar TTL de siete días. Sin conectividad, `availability_status` es solo el último estado conocido, no una promesa de disponibilidad actual. La interfaz muestra fecha de actualización y advertencia cuando se usa una copia vieja.

**Números oficiales:** no se inventan ni se codifican números de emergencia en el backend. `EmergencyNumber` se devuelve solo con `is_active=true` y `verified=true`. La alternativa general se filtra a categorías `general`, `general_emergency`, `general_emergencia`, `emergencia_general` o `national`. Antes de producción, administración debe ingresar y verificar un número nacional general con fuente oficial. Si el catálogo no contiene uno verificado, `emergency_alternative` será `[]`; la API no puede fabricar un número para satisfacer el fallback.

## 6. Creación y notificación

La referencia `address_reference_text` es obligatoria incluso con GPS. Se valida propiedad del vehículo, catálogo activo, coordenadas/rangos y límite de solicitudes por usuario/hora (default 3). El mismo UUID v7 repetido por el mismo usuario devuelve el registro existente; una solicitud activa duplicada por vehículo se rechaza con `ASSISTANCE_ALREADY_SUBMITTED`.

Si hay GPS y una ficha verificada cubre la ubicación para el tipo de servicio, el servidor encola BullMQ después del commit. BullMQ aplica cinco intentos con backoff exponencial. Si no hay GPS o cobertura, no envía una notificación falsa y devuelve la alternativa oficial verificada; la aplicación conserva la opción de llamada/WhatsApp manual.

La interfaz `AssistanceNotificationAdapter` desacopla el transporte. `mock` es el modo por defecto en desarrollo/test y no registra teléfonos ni texto personal en logs. `twilio` envía WhatsApp cuando hay sender WhatsApp configurado y teléfono de WhatsApp; de lo contrario usa SMS. El cuerpo incluye solicitante, teléfono de retorno, tipo de servicio, vehículo, descripción, referencia, enlace Google Maps y enlaces de aceptar/cancelar.

## 7. Enlaces de acción de un solo uso

Se generan 32 bytes aleatorios codificados base64url. Solo SHA-256 se persiste. El token se vincula a una solicitud, acción específica y vencimiento configurable (default 24 horas, máximo 24 horas). El `GET` solo presenta detalles y un formulario; nunca consume el token. El `POST` bloquea el token y la solicitud, verifica vencimiento/uso/transición, marca el token y sus hermanos como usados, registra el evento y aplica el estado. Tras `accepted` o `en_camino`, la página devuelve nuevos enlaces para el siguiente paso. Un enlace usado, vencido o fuera de transición responde como no disponible.

La página nunca ofrece cobrar ni solicitar pagos. No debe añadirse información de facturación a estos mensajes.

## 8. Configuración

| Variable | Uso | Default |
|---|---|---|
| `ASSISTANCE_NOTIFICATION_MODE` | `mock` o `twilio` | `mock` fuera de producción; `twilio` en producción |
| `ASSISTANCE_ACTION_TOKEN_TTL_SECONDS` | Vigencia del enlace de acción | `86400` |
| `ASSISTANCE_REQUEST_MAX_PER_HOUR` | Máximo de solicitudes por usuario/hora | `3` |
| `PUBLIC_API_BASE_URL` | URL pública incluyendo prefijo `/api/v1`, para construir enlaces | Obligatoria HTTPS en producción |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | Credenciales de envío | Requeridas con modo Twilio |
| `TWILIO_SMS_FROM` | Sender SMS E.164 de respaldo | Requerido con modo Twilio |
| `TWILIO_WHATSAPP_FROM` | Sender WhatsApp E.164 (sin prefijo `whatsapp:`) | Opcional; si falta, WhatsApp se envía como SMS |

No colocar estos secretos en el cliente móvil, en el paquete offline ni en logs.

## 9. Aceptación y límites de validación

| Criterio | Implementación | Estado de validación |
|---|---|---|
| Rechazar solicitud sin referencia textual | DTO + trim + constraint SQL heredado | Pendiente de ejecutar pruebas contra PostgreSQL |
| Sin cobertura, lista vacía y alternativa oficial | Búsqueda + filtro por categoría oficial verificada | Depende de que el catálogo tenga un general verificado |
| Notificación incluye ubicación y datos con adaptador simulado | Worker BullMQ + adapter `mock` | Código incorporado; ejecución con Redis/DB pendiente |
| Enlace de un solo uso y vencimiento | Token hash, expiración, bloqueo de filas y consumo atómico | Pendiente de prueba integrada |
| No mostrar importes de cobro | DTOs de B7 solo exponen estimaciones con disclaimer | Revisión estática incorporada |
| Paquete menor de 100 KB | Límite en bytes y poda de proveedores más lejanos | Pendiente de medir con fixtures de zona típica |

La migración `20261113130000_b7_roadside_assistance` debe aplicarse con el rol DDL de migraciones, nunca con `app_runtime`. No se deben ejecutar tests, cobertura ni Docker build como parte de esta entrega; se mantienen fuera de alcance hasta autorización posterior.
