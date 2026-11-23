-- Reversa B5.1: restaura el comportamiento anterior del trigger B5.
BEGIN;
CREATE OR REPLACE FUNCTION public.invalidate_emergency_number_verification()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.phone_number, NEW.category, NEW.department_id, NEW.municipality_id)
       IS DISTINCT FROM ROW(OLD.phone_number, OLD.category, OLD.department_id, OLD.municipality_id)
     AND NOT (
       NEW.verified = TRUE
       AND NEW.verified_at IS NOT NULL
       AND NEW.verified_by_user_id IS NOT NULL
       AND NEW.source_name IS NOT NULL
       AND length(btrim(NEW.source_name)) > 0
     ) THEN
    NEW.verified := FALSE;
    NEW.verified_at := NULL;
    NEW.verified_by_user_id := NULL;
    NEW.source_name := NULL;
    NEW.source_url := NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.invalidate_emergency_number_verification() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.invalidate_emergency_number_verification() TO app_runtime;
COMMIT;
