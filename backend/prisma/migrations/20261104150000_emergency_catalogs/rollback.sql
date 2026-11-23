-- Reversa B5: conservar respaldo previo de contactos y números antes de revertir.
DROP TRIGGER IF EXISTS municipalities_bump_catalog_version ON public.municipalities;
DROP TRIGGER IF EXISTS departments_bump_catalog_version ON public.departments;
DROP TRIGGER IF EXISTS specialties_bump_catalog_version ON public.specialties;
DROP TRIGGER IF EXISTS service_types_bump_catalog_version ON public.service_types;
DROP TRIGGER IF EXISTS emergency_numbers_bump_catalog_version ON public.emergency_numbers;
DROP TRIGGER IF EXISTS a_emergency_numbers_invalidate_verification ON public.emergency_numbers;
DROP FUNCTION IF EXISTS public.invalidate_emergency_number_verification();
DROP TRIGGER IF EXISTS z_emergency_contacts_sync_metadata ON public.emergency_contacts;
DROP TRIGGER IF EXISTS a_emergency_contacts_limit ON public.emergency_contacts;
DROP FUNCTION IF EXISTS public.enforce_emergency_contact_limit();
DROP TABLE IF EXISTS public.emergency_contacts;
DROP TABLE IF EXISTS public.emergency_numbers;
DROP TABLE IF EXISTS public.specialties;
DROP TABLE IF EXISTS public.service_types;
DROP TABLE IF EXISTS public.municipalities;
DROP TABLE IF EXISTS public.departments;
DELETE FROM public.catalog_versions WHERE catalog_name IN ('emergency-numbers','service-types','specialties','departments','municipalities');
