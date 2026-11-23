-- B0 foundation. Las extensiones se habilitan mediante bootstrap administrativo.
-- El rol app_migrator no recibe privilegios de superusuario para instalar extensiones.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') THEN
    RAISE EXCEPTION 'La extensión postgis debe instalarse antes de ejecutar esta migración.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    RAISE EXCEPTION 'La extensión pgcrypto debe instalarse antes de ejecutar esta migración.';
  END IF;
END;
$$;

CREATE SEQUENCE public.sync_version_seq
  AS BIGINT
  START WITH 1
  INCREMENT BY 1
  NO MINVALUE
  NO MAXVALUE
  CACHE 1;

CREATE OR REPLACE FUNCTION public.assign_sync_metadata()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  NEW.sync_version := nextval('public.sync_version_seq'::regclass);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_sync_metadata() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_sync_metadata() TO app_runtime;

CREATE TABLE public.foundation_metadata (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key VARCHAR(120) NOT NULL UNIQUE,
  value JSONB NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp()
);

COMMENT ON TABLE public.foundation_metadata IS
  'Metadatos técnicos internos de la API. No contiene datos de usuarios y no es sync-ready.';
COMMENT ON FUNCTION public.assign_sync_metadata() IS
  'Asigna updated_at y sync_version desde PostgreSQL a tablas sync-ready que adjunten este trigger; created_at se conserva si lo proporciona la API y tiene default en cada columna.';
