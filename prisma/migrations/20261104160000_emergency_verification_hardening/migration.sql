-- B5.1: una modificación directa del número o su procedencia no puede conservar
-- la verificación anterior. La revalidación administrativa se realiza en un
-- segundo UPDATE dentro de la misma transacción de NestJS.
BEGIN;

CREATE OR REPLACE FUNCTION public.invalidate_emergency_number_verification()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.phone_number, NEW.category, NEW.department_id, NEW.municipality_id,
         NEW.source_name, NEW.source_url)
       IS DISTINCT FROM ROW(OLD.phone_number, OLD.category, OLD.department_id, OLD.municipality_id,
                            OLD.source_name, OLD.source_url) THEN
    NEW.verified := FALSE;
    NEW.verified_at := NULL;
    NEW.verified_by_user_id := NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.invalidate_emergency_number_verification() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.invalidate_emergency_number_verification() TO app_runtime;

COMMIT;
