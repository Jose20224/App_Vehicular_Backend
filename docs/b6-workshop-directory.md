# B6 — Directorio de talleres

**Estado:** implementación de backend incorporada; validación integral pendiente para el cierre de todas las fases.  
**Stack:** NestJS, Prisma, PostgreSQL 16, PostGIS, Redis y S3.  
**Zona horaria del horario comercial:** `America/Managua`.

## 1. Alcance

B6 incorpora las fichas de taller, especialidades, fotografías, ofertas de servicio, búsqueda geoespacial y eventos de contacto. No incorpora administración offline B2B: por D-061 los talleres/proveedores no forman parte de la réplica del conductor B5S. La búsqueda pública devuelve hasta 50 resultados para que Flutter conserve el último resultado con `cache_ttl_seconds` y `fetched_at` según el contrato offline.

`AssistanceProvider` se crea en esta migración como ancla relacional mínima (identidad, propietario, tipo de servicio, ubicación base y estado). Es necesaria para que `ServiceOffering` tenga una FK real y se pueda imponer `workshop XOR assistance_provider` desde PostgreSQL. Su perfil completo y endpoints propios quedan para la fase de proveedores.

## 2. Modelos y reglas

- `Workshop`: perfil de negocio con nombre, descripción, datos públicos de contacto cifrados en reposo, dirección, referencia local, departamento, municipio, punto `geography(Point,4326)`, horario semanal, resumen de calificación y estado.
- `WorkshopSpecialty`: relación taller-especialidad con borrado lógico y unicidad parcial para asociaciones activas.
- `WorkshopPhoto`: metadata, `object_key` privada, MIME, tamaño, checksum opcional, orden y estado; una foto solo se publica después de verificar el objeto en S3.
- `ServiceOffering`: servicio, rango de precio, moneda, unidad, notas, `last_updated_at`, disponibilidad y estado de publicación.
- `WorkshopContactEvent`: únicamente `workshop_id`, `event_type` y fecha. No almacena usuario, IP, dispositivo, teléfono ni coordenadas del visitante.

Los datos de contacto se cifran mediante `FieldCryptoService` con AAD v2 ligado a usuario y registro. Solo el endpoint de contacto devuelve los campos descifrados, y únicamente cuando el taller está `active` y no está eliminado.

Estados de taller: `draft`, `pending_verification`, `active`, `suspended`. Solo `active` se incluye en búsqueda, detalle público, contacto y eventos. El dueño solicita verificación; únicamente `admin` puede activar o suspender.

La referencia local no es opcional para activar: existe un `CHECK` en PostgreSQL que impide `status='active'` si `address_reference_text` es nulo o vacío. La activación también exige dirección, ubicación y municipio/departamento coherentes. Teléfono, WhatsApp y correo son campos de contacto opcionales y cada valor presente se cifra en reposo.

## 3. Horario semanal

`weekly_schedule` es JSONB con claves inglesas minúsculas `monday` a `sunday`; cada día contiene un arreglo de intervalos. Ejemplo:

```json
{
  "monday": [{ "open": "08:00", "close": "17:00" }],
  "tuesday": [{ "open": "08:00", "close": "17:00" }],
  "wednesday": [{ "open": "08:00", "close": "17:00" }],
  "thursday": [{ "open": "08:00", "close": "17:00" }],
  "friday": [{ "open": "08:00", "close": "17:00" }],
  "saturday": [{ "open": "08:00", "close": "12:00" }],
  "sunday": []
}
```

Las horas usan `HH:MM` (24 horas). Se aceptan hasta cuatro intervalos por día y se rechazan intervalos superpuestos. `open == close` representa servicio de 24 horas. Un intervalo cuyo cierre es anterior a su apertura cruza medianoche. El cálculo usa el reloj del servidor convertido a `America/Managua`; no depende de la zona horaria declarada por el teléfono.

PostgreSQL expone `workshop_is_open_now(schedule, timestamp)` para filtrar por `open_now` dentro de la búsqueda. La ficha de detalle utiliza la misma zona horaria para mostrar `is_open_now`.

## 4. Endpoints

Base path: `/api/v1`. Las rutas marcadas como públicas no requieren JWT; aplican el rate limit global de rutas públicas.

| Método | Ruta | Acceso | Función |
|---|---|---|---|
| GET | `/workshops/mine` | `workshop_owner` | Listar fichas propias en cualquier estado. |
| GET | `/workshops/mine/:id` | `workshop_owner` | Consultar ficha propia completa, incluidos borradores y datos de contacto descifrados para su dueño. |
| POST | `/workshops` | `workshop_owner` | Crear ficha `draft`; UUID v7 de cliente. |
| PATCH | `/workshops/:id` | `workshop_owner` | Editar nombre, descripción, contactos, dirección, territorio, ubicación y horario. |
| POST | `/workshops/:id/submit-verification` | `workshop_owner` | Enviar ficha completa a revisión. |
| PATCH | `/workshops/:id/status` | `admin` | Activar, suspender o devolver a verificación. |
| PUT | `/workshops/:id/specialties` | `workshop_owner` | Reemplazar las especialidades activas. |
| POST | `/workshops/:id/photos/upload-url` | `workshop_owner` | Crear metadata y URL PUT firmada S3. |
| POST | `/workshops/photos/:photoId/confirm` | `workshop_owner` | Verificar MIME/tamaño desde S3 y publicar. |
| GET | `/workshops/search` | Público | Búsqueda y caché de resultados. |
| GET | `/workshops/:slug` | Público | Ficha pública activa. |
| GET | `/workshops/:slug/contact-details` | Público | Teléfono, WhatsApp y correo descifrados de ficha activa. |
| POST | `/workshops/:slug/contact-events` | Público | Registrar `call`, `whatsapp` o `route_click`. |
| POST | `/service-offerings` | `workshop_owner` / `provider_owner` | Crear oferta `draft`, declarando exactamente un dueño. |
| PATCH | `/service-offerings/:id` | Dueño | Actualizar precio, descripción o publicación. |
| DELETE | `/service-offerings/:id` | Dueño | Retirar oferta mediante borrado lógico. |

### Búsqueda

Parámetros opcionales: `lat`, `lng`, `radius_meters` (100–50 000; default 5 000), `specialty_id`, `municipality_id`, `q`, `open_now` y `limit` (1–50; default 20). `lat` y `lng` deben llegar juntos.

Cuando hay coordenadas, la consulta filtra con `ST_DWithin(workshops.location, point, radius_meters)`, usa el índice GiST y calcula distancia con `ST_Distance`. La ordenación queda: `sponsored DESC`, distancia ascendente, calificación descendente, cantidad de calificaciones descendente e ID para estabilidad. Sin coordenadas, distancia es nula y se ordena por calificación. Texto consulta nombre, descripción, dirección y referencia local mediante `search_document` (TSVECTOR generado + GIN); especialidad usa `EXISTS` sobre asociaciones activas. Cada resultado incluye `weekly_schedule` para que Flutter pueda recalcular el horario localmente cuando la copia offline envejezca; `is_open_now` corresponde a `open_now_calculated_at` y `fetched_at`.

El resultado incluye `fetched_at`, `cache_ttl_seconds: 604800`, `max_cache_records: 50` y `timezone: America/Managua`. Redis usa un caché efímero de 60 segundos con clave versionada; invalidar el directorio incrementa `directory:workshops:version` en O(1), sin ejecutar `KEYS`.

El resultado de búsqueda no devuelve el teléfono descifrado. Devuelve `contact_available`; el cliente obtiene el contacto tras la acción deliberada desde `GET /workshops/:slug/contact-details`. Esto evita cientos de operaciones KMS en una consulta de proximidad y ayuda a mantener el objetivo de latencia.

### Patrocinados y B9

B6 devuelve `sponsored: false` y reserva ese campo en la selección/ordenación. B9 debe sustituir el literal por una evaluación de campañas vigentes, aprobadas y pagadas. La publicidad se etiqueta siempre como patrocinada y nunca altera la calificación ni la ordenación orgánica fuera de la prioridad del espacio promocionado.

## 5. Precios

La moneda canónica de negocio es USD. B6 acepta `currency='USD'`; cualquier futura presentación equivalente en NIO necesitará una tasa aprobada y fuente/fecha, no un precio editable paralelo.

Toda respuesta pública que incluya `price_min` o `price_max` agrega exactamente este texto:

> Precio estimado. El pago se realiza directamente al taller o al proveedor cuando se presta el servicio.

El servidor marca `price_status='desactualizado'` cuando `last_updated_at` tiene más de 90 días; en caso contrario `actualizado`. `last_updated_at` se mantiene con un trigger de PostgreSQL y solo se renueva cuando cambia el rango, moneda, unidad o nota del precio; editar el nombre o la descripción no rejuvenece una cotización antigua.

## 6. Integridad y seguridad en base de datos

- `service_offerings` tiene `CHECK ((workshop_id IS NOT NULL) <> (assistance_provider_id IS NOT NULL))`.
- Ambas FKs son compuestas `(owner_id,user_id)` contra `UNIQUE(id,user_id)` del dueño correspondiente.
- El propietario de un taller debe tener rol `workshop_owner` (o `admin`); el de un proveedor, `provider_owner` (o `admin`).
- La relación taller-municipio es compuesta `(municipality_id,department_id)`.
- El directorio público siempre filtra `status='active' AND deleted_at IS NULL`.
- Las tablas editables conservan metadata y trigger global `sync_version`; no se incorporan a la allow-list de B5S del conductor.

## 7. Seeds de rendimiento

`prisma/seeds/workshops-test.ts` crea 5 000 fichas sintéticas con coordenadas deterministas alrededor de Managua. `seedTesting()` lo invoca únicamente cuando `NODE_ENV=test`; los seeds de desarrollo/producción no llaman ese archivo. Los fixtures no generan teléfonos ni otros datos de contacto, y la ubicación de prueba no contiene datos de negocios reales.

Se agregó `test/migrations/b6-service-offering-xor.sql` para comprobar en PostgreSQL que se aceptan ambas variantes válidas (taller único y proveedor único), mientras cero dueños y dos dueños producen `check_violation`. También comprueba el CHECK de activación sin referencia local. Este SQL queda preparado; no se ha ejecutado como parte de B6.

`test/performance/b6-workshop-search.k6.js` es una sonda HTTP opcional para medir el endpoint completo contra un entorno aislado con los 5 000 registros sintéticos. Configura `API_BASE_URL`, `VUS` y `DURATION`; establece el umbral de latencia p95 inferior a 300 ms y comprueba que el resultado esté ordenado por distancia y lleve los metadatos de caché. No se ha ejecutado.

## 8. Estado de aceptación

| Criterio | Implementación |
|---|---|
| Búsqueda por radio 5 km con GiST + distancia | Incorporada en SQL; latencia <300 ms pendiente de medición de rendimiento en entorno de pruebas. |
| Taller sin referencia local no se activa | CHECK en PostgreSQL y validación en NestJS. |
| Taller suspendido no aparece | Todas las rutas públicas filtran `status='active'`. |
| Respuestas que incluyen precios contienen texto legal | Serializer de ofertas + disclaimer global en búsqueda/detalle. |
| XOR probado a nivel BD | CHECK físico y script SQL de aceptación preparado; no ejecutado. |

**No se han ejecutado instalaciones, tests, builds, migraciones, Docker, consultas de rendimiento ni conexiones a servidores.**
