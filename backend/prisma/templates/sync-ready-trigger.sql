-- Plantilla para migraciones futuras que creen una tabla sync-ready.
-- Reemplazar <table_name> por un identificador fijo de esquema (nunca por entrada HTTP).
-- Antes del trigger, la tabla debe definir: id UUID PRIMARY KEY generado por cliente,
-- user_id UUID NOT NULL con FK a la tabla propietaria, created_at/updated_at timestamptz,
-- deleted_at timestamptz NULL y sync_version bigint NOT NULL DEFAULT 0.
-- Exigir UUID v7 (RFC 9562) en PostgreSQL 16 mediante esta restricción: 
-- CHECK (substring(id::text FROM 15 FOR 1) = '7' AND substring(id::text FROM 20 FOR 1) IN ('8','9','a','b')).
-- Crear siempre un índice B-tree por user_id y filtrar consultas/escrituras por el propietario.

CREATE TRIGGER trg_<table_name>_sync_metadata
BEFORE INSERT OR UPDATE ON public.<table_name>
FOR EACH ROW
EXECUTE FUNCTION public.assign_sync_metadata();

-- El trigger siempre reemplaza sync_version enviado por el cliente y actualiza updated_at.
-- created_at se conserva si el cliente aporta la fecha de creación offline; la columna debe tener default.
-- No crear triggers en tablas técnicas ni de solo lectura del cliente.
