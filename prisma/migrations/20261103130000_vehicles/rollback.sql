-- Reversa B2: ejecutar solo con la API detenida y respaldo previo.
-- No elimina datos ni objetos S3. Antes de revertir en cualquier entorno con datos
-- operativos, exportar/respaldar los registros de vehicles y revisar dependencias.
DROP TRIGGER IF EXISTS z_vehicles_sync_metadata ON public.vehicles;
DROP TRIGGER IF EXISTS a_vehicles_validate_catalog_and_year ON public.vehicles;
DROP TABLE IF EXISTS public.vehicles;
DROP FUNCTION IF EXISTS public.validate_vehicle_catalog_and_year();
DROP TRIGGER IF EXISTS vehicle_models_bump_catalog_version ON public.vehicle_models;
DROP TRIGGER IF EXISTS vehicle_brands_bump_catalog_version ON public.vehicle_brands;
DROP FUNCTION IF EXISTS public.bump_vehicle_catalog_version();
DROP TABLE IF EXISTS public.catalog_versions;
DROP TABLE IF EXISTS public.vehicle_models;
DROP TABLE IF EXISTS public.vehicle_brands;
DROP TYPE IF EXISTS public.vehicle_photo_status;
DROP TYPE IF EXISTS public.vehicle_type;
