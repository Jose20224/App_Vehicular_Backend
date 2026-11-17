# FASE B11: Portal de dueños y backoffice

## Dueños

Las rutas de talleres y proveedores ya existentes cubren perfiles propios, fotos de taller en S3, horarios y especialidades de taller, ofertas/precios estimados, planes publicitarios y respuestas a reseñas. B11 agrega métricas de propietario (`GET /workshops/mine/:id/metrics` y `GET /assistance-providers/mine/:id/metrics`) con ventana de 30 días, siempre filtradas por propietario. Las reclamaciones se solicitan en `POST /business-claims/workshops` o `/providers` con `business_id` y evidencia opcional.

## Administración

- `GET /admin/dashboard`: usuarios activos, documentos que vencen en 30 días, solicitudes agrupadas por estado, ingresos por plan y ocupación por espacio/departamento.
- `GET /admin/business-claims` y `PATCH /admin/business-claims/:id`: cola de reclamaciones y verificación manual. La aprobación cambia el propietario y deja el negocio en `pending_verification`; una reclamación ya procesada o un negocio reclamado se rechazan.
- `POST /admin/imports/emergency-numbers-csv`: CSV JSON con encabezados `label,category,phone_number` y columnas opcionales de ubicación/fuente. Cada fila se procesa independientemente y la respuesta enumera fila y motivo de error.
- `PATCH /admin/catalogs/active`: activa/desactiva elementos de catálogos y avanza su versión.
- La moderación de reseñas, estados de negocios, planes/cupos, pagos y números de emergencia se integra con las rutas administrativas de B6–B10.

## Auditoría

El interceptor registra las escrituras de usuarios administradores en `admin_audit_logs`, incluyendo actor, acción, fecha, recurso y snapshots anterior/posterior cuando el recurso puede identificarse. Los campos de contacto y credenciales se redactan en los snapshots.

Aplicar la migración `20261118100000_b11_owner_admin_portal` después de B10 y ejecutar `npm run prisma:generate`.
