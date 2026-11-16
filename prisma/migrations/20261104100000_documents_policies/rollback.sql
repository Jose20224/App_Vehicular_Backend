-- Reversa B3. Debe ejecutarse solo cuando se haya decidido retirar el dominio de documentos.
DROP TRIGGER IF EXISTS a_vehicle_document_policy_owner ON public.vehicle_documents;
DROP FUNCTION IF EXISTS public.validate_vehicle_document_policy_owner();
DROP TRIGGER IF EXISTS a_insurance_policy_relationships ON public.insurance_policies;
DROP FUNCTION IF EXISTS public.validate_insurance_policy_relationships();
DROP TRIGGER IF EXISTS insurers_bump_catalog_version ON public.insurers;
DROP TRIGGER IF EXISTS insurance_policies_sync_metadata ON public.insurance_policies;
DROP TRIGGER IF EXISTS vehicle_documents_sync_metadata ON public.vehicle_documents;
DROP TABLE IF EXISTS public.vehicle_documents;
DROP TABLE IF EXISTS public.insurance_policies;
DELETE FROM public.catalog_versions WHERE catalog_name = 'insurers';
DROP TABLE IF EXISTS public.insurers;
DROP TYPE IF EXISTS public.insurance_policy_status;
DROP TYPE IF EXISTS public.document_file_status;
DROP TYPE IF EXISTS public.vehicle_document_type;

ALTER TABLE public.vehicles DROP CONSTRAINT IF EXISTS chk_vehicles_aad_versions;
ALTER TABLE public.vehicles DROP COLUMN IF EXISTS vin_aad_version;
ALTER TABLE public.vehicles DROP COLUMN IF EXISTS plate_aad_version;
