# B8 — Reseñas y calificaciones

**Estado:** implementación incorporada; validación integral pendiente.  
**Dependencia:** B6 (directorio de talleres).  
**Stack:** NestJS, Prisma y PostgreSQL.  
**Migración:** `prisma/migrations/20261113150000_b8_reviews_ratings/`.

## 1. Alcance y reglas

B8 incorpora reseñas de talleres. Cada reseña pertenece a un usuario y un taller, tiene calificación entera de 1 a 5, comentario opcional de hasta 500 caracteres y un vehículo opcional que debe pertenecer al usuario autenticado. Las reseñas son online-only y no se agregan a `/sync/push` ni `/sync/pull`; B5S ya excluye `review` y `review_reply` de la réplica offline del conductor.

- Solo usuarios con rol `user` pueden crear reseñas; el taller debe estar activo y publicado.
- Un usuario puede crear una reseña para el mismo taller una vez cada seis meses. El control se ejecuta dentro de una transacción, bloquea la fila del taller y usa el reloj de PostgreSQL. Los intentos anteriores cuentan incluso si la reseña luego se rechaza o retira, para impedir eludir el enfriamiento.
- Toda reseña nueva empieza en `pending`. El filtro básico detecta vocabulario ofensivo y marca `content_flagged`; esto prioriza la cola, no sustituye la decisión humana.
- Solo `admin` activo puede aprobar, rechazar o retirar reseñas.
- Solo el dueño del taller puede insertar una respuesta, una por reseña publicada. B8 no ofrece edición ni eliminación de respuestas.
- Usuarios pueden reportar cualquier reseña publicada. Un dueño solo puede reportar reseñas del taller que posee. El motivo tiene entre 10 y 500 caracteres y se admite un reporte abierto por cuenta/reseña.

## 2. Protección de integridad y reputación

PostgreSQL impide el borrado físico de reseñas y hace inmutables autor, taller, vehículo, calificación, comentario y fecha de creación. Las transiciones de moderación requieren `app.actor_user_id` configurado dentro de la transacción y que ese usuario exista, esté activo y tenga rol `admin`.

Los campos `workshops.rating_average` y `workshops.rating_count` no se pueden cambiar desde flujos ordinarios. Un trigger de reseñas los recalcula después de insertar, aprobar o retirar una reseña, contando exclusivamente `status='published'` y `deleted_at IS NULL`. El trigger y la actualización de estado participan en la misma transacción PostgreSQL.

No se implementan endpoints de propietario o publicidad para ocultar, borrar, editar, ordenar o moderar reseñas. El propietario únicamente puede responder y reportar. La moderación vive bajo `/admin/reviews` y requiere rol `admin`.

## 3. Endpoints

Base: `/api/v1`.

| Método | Ruta | Acceso | Función |
|---|---|---|---|
| GET | `/workshops/:workshopId/reviews` | Público | Reseñas publicadas, respuestas, promedio y total. |
| POST | `/reviews` | `user` | Crear reseña pendiente. |
| POST | `/reviews/:reviewId/reports` | `user`, `workshop_owner` | Reportar una reseña con motivo. |
| POST | `/workshops/:workshopId/reviews/:reviewId/reply` | Dueño de taller | Publicar la única respuesta del taller. |
| GET | `/admin/reviews/moderation-queue` | `admin` | Cola pendiente, señaladas por filtro primero. |
| PATCH | `/admin/reviews/:reviewId/moderation` | `admin` | Aprobar, rechazar o retirar. |
| GET | `/admin/reviews/reports` | `admin` | Consultar reportes. |
| PATCH | `/admin/reviews/reports/:reportId` | `admin` | Resolver o descartar un reporte. |

No existen rutas PATCH/DELETE públicas para reseñas ni rutas de dueño para alterar su estado o contenido.

## 4. Estados

`pending` → `published` | `rejected`; `published` → `removed` (retiro lógico reservado a admin). No se permite reabrir una reseña rechazada o retirada en B8. `removed` conserva `published_at` para trazabilidad, fija `deleted_at` y deja de contar en el promedio.

## 5. Cálculo de calificación

La media se calcula con dos decimales y el total cuenta solo reseñas publicadas no retiradas. Al aprobar una reseña entra en el promedio; una rechazada no entra. Al retirar una publicada se recalcula y desaparece del total. Las operaciones son atómicas a nivel de base de datos.

## 6. Seguridad y pruebas

- `test/unit/reviews.authorization.spec.ts` comprueba el escenario de un taller con campaña activa: el rol `workshop_owner` solo tiene `POST` de respuesta y reporte; la moderación/resolución corresponde exclusivamente a `admin`.
- La migración protege la inmutabilidad de reseñas, exige actor admin para moderación y protege los agregados de reputación contra escrituras directas de otros flujos.
- `rollback.sql` revierte objetos B8.

**Validación pendiente:** no se ejecutaron `npm install`, Prisma Generate/Validate, tests, build ni migraciones. El entorno de trabajo de esta entrega no contiene `node_modules`; la validación integral se mantiene para el cierre acordado de fases.
