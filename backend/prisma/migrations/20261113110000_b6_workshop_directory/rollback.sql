-- Reversión de B6. Ejecutar solo si se decide retirar el directorio antes de que
-- existan datos reales dependientes. No elimina datos en cascada.
BEGIN;
DROP TRIGGER IF EXISTS service_offerings_sync_metadata ON public.service_offerings;
DROP TRIGGER IF EXISTS service_offerings_touch_last_updated ON public.service_offerings;
DROP TRIGGER IF EXISTS workshop_photos_sync_metadata ON public.workshop_photos;
DROP TRIGGER IF EXISTS workshop_specialties_sync_metadata ON public.workshop_specialties;
DROP TRIGGER IF EXISTS workshops_sync_metadata ON public.workshops;
DROP TRIGGER IF EXISTS assistance_providers_sync_metadata ON public.assistance_providers;
DROP TRIGGER IF EXISTS workshops_owner_role ON public.workshops;
DROP TRIGGER IF EXISTS assistance_providers_owner_role ON public.assistance_providers;
DROP FUNCTION IF EXISTS public.touch_service_offering_last_updated();
DROP FUNCTION IF EXISTS public.enforce_provider_owner_role();
DROP FUNCTION IF EXISTS public.enforce_workshop_owner_role();
DROP FUNCTION IF EXISTS public.workshop_is_open_now(JSONB, TIMESTAMPTZ);
DROP TABLE IF EXISTS public.workshop_contact_events;
DROP TABLE IF EXISTS public.service_offerings;
DROP TABLE IF EXISTS public.workshop_photos;
DROP TABLE IF EXISTS public.workshop_specialties;
DROP TABLE IF EXISTS public.workshops;
DROP TABLE IF EXISTS public.assistance_providers;
DROP TYPE IF EXISTS public.workshop_contact_event_type;
DROP TYPE IF EXISTS public.service_offering_status;
DROP TYPE IF EXISTS public.workshop_photo_status;
DROP TYPE IF EXISTS public.workshop_status;
COMMIT;
