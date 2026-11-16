# B5 — Catálogos y datos de emergencia

**Estado:** implementado en API y migración SQL; requiere instalación/validación local de Prisma y seeds antes de su uso.
**Zona operativa:** `America/Managua`.

## Catálogos públicos

`GET /api/v1/catalogs/:name` permite los siguientes nombres: `vehicle-brands`, `vehicle-models`, `insurers`, `emergency-numbers`, `service-types`, `specialties`, `departments` y `municipalities`. Los filtros soportados son `brand_id` (solo modelos) y `department_id` (solo municipios). Cada respuesta contiene `catalog`, `catalog_version` e `items`, e incluye el header `ETag`. Si `If-None-Match` coincide, responde `304` sin cuerpo.

`GET /api/v1/catalogs/status` devuelve todas las versiones, el ETag individual y la fecha de modificación de cada catálogo. El endpoint tiene además un ETag global calculado sobre el mapa de versiones. El móvil consulta este endpoint durante el bootstrap y descarga solamente los catálogos cuyo ETag local cambió.

Redis cachea el contenido por catálogo, filtros y versión durante una hora. La versión se lee desde PostgreSQL en cada consulta; los triggers incrementan la versión dentro de la misma transacción que modifica el catálogo. Si Redis no está disponible, el servicio consulta PostgreSQL y sigue atendiendo el catálogo.

## Catálogos territoriales

Los seeds cargan 17 unidades administrativas de primer nivel (15 departamentos y 2 regiones autónomas) y 153 municipios. Los códigos usados por la aplicación son claves internas estables; no se exponen como códigos INIDE oficiales. El origen territorial se documenta a partir del portal de límites de INETER, que publica capas departamentales y municipales, y de la codificación territorial publicada en documentos oficiales de MINSA/INIDE. Las listas deben revisarse contra la cartografía oficial cuando INETER publique una actualización.

Fuentes:

- CSE, [Ley de División Política Administrativa](https://cse.gob.ni/es/documentos/marco-juridico-vigente/ley-de-division-politica-administrativa): ficha del marco jurídico vigente; el texto consolidado de la Ley 59 establece 15 departamentos, 2 regiones autónomas y 153 municipios.
- INETER, [Límites de Nicaragua](https://www.ineter.gob.ni/geoportales/miacnicaragua/index.html): capas y metadatos de límites nacionales, departamentales y municipales.
- MINED, [División política y administrativa de Nicaragua](https://www.mined.gob.ni/biblioteca/wp-content/uploads/2024/09/eess-4to-BAJA.pdf): confirma la división en 15 departamentos, 2 regiones autónomas y 153 municipios.

La Ley 59 también describe adscripciones administrativas provisionales para algunos municipios de las regiones autónomas. El seed mantiene la agrupación base del Artículo 6; los despliegues que necesiten usar el campo territorial como jurisdicción operativa deben validar esas adscripciones con INETER y las autoridades correspondientes. Los códigos del seed son identificadores internos, no códigos oficiales INIDE.

## Números de emergencia

La API de administración requiere rol `admin`:

| Método | Ruta | Comportamiento |
|---|---|---|
| GET | `/api/v1/admin/emergency-numbers` | Lista registros verificados, pendientes e inactivos. |
| POST | `/api/v1/admin/emergency-numbers` | Crea con `verified=false` salvo verificación explícita y fuente obligatoria. |
| PATCH | `/api/v1/admin/emergency-numbers/:id` | Cambia datos o estado; todo cambio incrementa `emergency-numbers`. |
| DELETE | `/api/v1/admin/emergency-numbers/:id` | Desactiva lógicamente el número y cambia la versión del catálogo. |

La API pública solo devuelve `is_active=true AND verified=true`. Para verificar se requiere `source_name`; el servidor asigna `verified_at` y `verified_by_user_id`. Un trigger PostgreSQL invalida la verificación previa cuando cambia el teléfono, categoría o ámbito territorial, salvo que la misma operación aporte una nueva verificación con fuente, fecha y administrador. Los números nacionales cortos se admiten además de teléfonos E.164. No se suministran números de ejemplo, marcadores ni datos inferidos: el seed intencionalmente no inserta registros en `emergency_numbers` hasta recibir números contrastados con una fuente primaria.

## Contactos de emergencia

El usuario autenticado gestiona exclusivamente sus contactos:

- `GET /api/v1/me/emergency-contacts`
- `POST /api/v1/me/emergency-contacts`
- `PATCH /api/v1/me/emergency-contacts/:id`
- `DELETE /api/v1/me/emergency-contacts/:id`

El móvil genera UUID v7. Teléfono E.164 se cifra AES-256-GCM con AAD v2 que incorpora propietario y contacto; el HMAC usa una clave de propósito separado. La respuesta descifra el teléfono únicamente para el propietario autenticado por TLS. Un trigger PostgreSQL y un bloqueo transaccional serializan altas concurrentes y rechazan el sexto contacto activo. Se conserva como máximo un contacto principal activo. El borrado lógico también purga el teléfono cifrado; la eliminación de cuenta realiza la misma anonimización. La exportación de cuenta incluye los contactos y sus teléfonos descifrados para el titular.

## Mensaje para compartir por WhatsApp

`POST /api/v1/emergency/share-message` acepta:

```json
{
  "vehicle_id": "UUID-del-vehiculo-propio",
  "latitude": 12.136389,
  "longitude": -86.251389,
  "reference": "Frente al parque, una cuadra al sur"
}
```

El backend confirma que el vehículo pertenece al usuario, obtiene nombre y teléfono de la cuenta, construye un enlace de Google Maps y devuelve `message`, `map_url` y `whatsapp_url`. El texto contiene nombre, teléfono, vehículo, ubicación y referencia. No incluye placa ni VIN, no persiste la ubicación ni el texto y no envía el mensaje automáticamente; el usuario revisa y comparte mediante WhatsApp.

## Migración y reversa

- Migración: `prisma/migrations/20261104150000_emergency_catalogs/migration.sql`.
- Reversa para pruebas aisladas: `prisma/migrations/20261104150000_emergency_catalogs/rollback.sql`.
- Catálogos territoriales y de asistencia se cargan por `npm run db:seed` con `DATABASE_MIGRATION_URL` y el rol `app_migrator`.
- En producción no ejecutar `rollback.sql`; usar corrección hacia adelante y procedimiento de despliegue aprobado.


### Endurecimiento B5.1 de la verificación

Los cambios de teléfono, categoría, cobertura territorial o fuente invalidan siempre la verificación previa mediante trigger PostgreSQL, incluidos cambios directos fuera de NestJS. Para una modificación y revalidación administrativa en una sola petición, el servicio ejecuta primero la modificación (que invalida) y después registra la verificación nueva en un segundo `UPDATE` dentro de la misma transacción.
