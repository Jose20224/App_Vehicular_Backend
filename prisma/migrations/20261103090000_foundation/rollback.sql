-- Reversa B0 foundation. Ejecutar solamente con la API detenida y previa copia de seguridad.
-- No elimina las extensiones postgis ni pgcrypto: pueden ser compartidas por otras migraciones.

DROP TABLE IF EXISTS public.foundation_metadata;
DROP FUNCTION IF EXISTS public.assign_sync_metadata();
DROP SEQUENCE IF EXISTS public.sync_version_seq;
