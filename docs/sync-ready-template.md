# Plantilla de tablas sync-ready

Esta guía complementa `src/database/sync-ready.ts` y `prisma/templates/sync-ready-trigger.sql`. No es una migración ejecutable ni autoriza crear tablas fuera de la fase correspondiente.

Toda entidad editable offline propiedad de una cuenta debe declarar:

- `id UUID PRIMARY KEY`, generado como UUID v7 por el cliente y respetado por el servidor.
- Restricción de versión UUID v7 (RFC 9562); las colisiones de clave primaria se rechazan, nunca se reemplaza el ID.
- `user_id UUID NOT NULL`, FK a la tabla de propietario e índice B-tree propio.
- `created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp()`.
- `updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp()`.
- `deleted_at TIMESTAMPTZ(6) NULL` para borrado lógico.
- `sync_version BIGINT NOT NULL DEFAULT 0`, asignado siempre por el trigger global.

Ejemplo del check UUID v7 para PostgreSQL 16:

```sql
CONSTRAINT chk_<table_name>_uuid_v7 CHECK (
  substring(id::text FROM 15 FOR 1) = '7'
  AND substring(id::text FROM 20 FOR 1) IN ('8', '9', 'a', 'b')
)
```

Cada tabla añade su propia FK de `user_id`, índice y trigger:

```sql
CREATE INDEX idx_<table_name>_user_id ON public.<table_name>(user_id);

CREATE TRIGGER trg_<table_name>_sync_metadata
BEFORE INSERT OR UPDATE ON public.<table_name>
FOR EACH ROW EXECUTE FUNCTION public.assign_sync_metadata();
```

La función conserva `created_at`, asigna `updated_at` con hora del servidor y obtiene `sync_version` de `public.sync_version_seq`. El cliente nunca envía un valor aceptado para `sync_version`. Consultas de lectura y escritura siempre limitan por `user_id`; los registros técnicos con FK de usuario no son automáticamente sync-ready.

No aplicar esta plantilla a catálogos, recordatorios calculados por servidor, tokens, logs, auditoría, colas ni tablas de idempotencia.
