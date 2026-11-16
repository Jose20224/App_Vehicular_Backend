# Fase B9: publicidad y planes

## Alcance implementado

- `AdPlan`, `AdSlot`, `AdCampaign` y `AdMetric` en PostgreSQL. La migración crea los cuatro espacios definidos: `featured_banner`, `sponsored_result`, `map_pin` y `premium_profile`.
- Cada espacio limita campañas reservadas globalmente y por departamento. Enviar una campaña a pago la bloquea como `pending_payment` por 24 horas; la transacción toma primero un advisory lock del espacio y después uno del departamento antes de consultar y reservar cupos. El job cancela pagos no confirmados al vencer esa reserva.
- La máquina de estados permite `draft → pending_payment → active → paused/expired/cancelled`. También permite cancelar desde borrador, pendiente de pago o pausa. La API rechaza las demás transiciones.
- La activación requiere `payment_confirmed_at`. Solo un administrador puede confirmar el pago. Una campaña futura queda pendiente y el job diario la activa al llegar su fecha.
- El worker BullMQ diario vence campañas activas o pausadas al llegar `ends_at`, y registra una notificación interna al anunciante cuando faltan siete días o menos. `GET /notifications` expone el tipo, texto y campaña del aviso `AD_CAMPAIGN_EXPIRING_7_DAYS`.
- El endpoint de anuncios filtra por espacio, departamento y opcionalmente municipio. Ordena por la campaña servida menos recientemente y actualiza `last_served_at` dentro de la misma transacción que serializa la rotación. El `expires_at` de la respuesta limita la caché del cliente a 24 horas o al vencimiento de la campaña, lo que ocurra primero.
- La búsqueda de talleres B6 antepone patrocinados y conserva los criterios previos de orden entre todos los resultados con la misma prioridad. Cada resultado expone `sponsored`, `patrocinado`, `sponsored_campaign_id` y `expires_at`.
- Los eventos guardan solo campaña, usuario, tipo y hora. Una ventana móvil de 30 minutos elimina duplicados por usuario/campaña/tipo y se protege con un advisory lock por esa combinación. Los reportes agregan impresiones, clics, llamadas, WhatsApp y rutas por período.
- Los planes cobran en USD. El equivalente NIO es informativo y guarda una instantánea de la tasa del plan. El precio base mensual, tasa y descuentos trimestral/anual se configuran por administración.

## API

| Método y ruta | Acceso | Uso |
|---|---|---|
| `GET /ads/plans` | Público | Planes activos y equivalente informativo NIO. |
| `GET /ads/serve?slot_code=&department_id=&municipality_id=&limit=` | Público | Rotación equitativa del espacio para la zona. |
| `POST /ads/campaigns` | Dueño de taller/proveedor | Crear borrador; debe indicar exactamente un negocio propio. |
| `GET /ads/campaigns/mine` | Dueño | Listar campañas propias. |
| `POST /ads/campaigns/:id/submit` | Dueño | Reservar cupo y pasar a pendiente de pago. |
| `POST /ads/campaigns/:id/confirm-payment` | Admin | Registrar confirmación y activar si ya empezó. |
| `POST /ads/campaigns/:id/pause` | Dueño | Pausar una campaña activa y retirarla de publicación. |
| `POST /ads/campaigns/:id/cancel` | Dueño | Cancelar una campaña no terminal. |
| `POST /ads/metrics` | Usuario autenticado | Registrar un evento publicitario. |
| `GET /ads/campaigns/:id/report?from=&to=` | Dueño/admin | Métricas agregadas por período. |
| `POST /ads/admin/plans` | Admin | Crear/actualizar plan y tipo de cambio/descuentos. |
| `POST /ads/admin/slots` | Admin | Ajustar límites de cupo de uno de los cuatro espacios. |

La confirmación de pago es una compuerta administrativa para el flujo actual. No procesa cobros ni reemplaza el comprobante/pasarela de la fase de facturación; un pago sin confirmación administrativa no puede activar ni publicar una campaña.

## Migración y validación

Aplicar `20261116120000_b9_advertising` antes de desplegar el backend. El cliente Prisma se genera con `npm run prisma:generate`. La prueba de cupo concurrente incluida es un unit test que modela el advisory lock; se recomienda añadir una prueba PostgreSQL/Testcontainers de extremo a extremo cuando el runtime de contenedores esté disponible.
