-- Plan de rendimiento B6 para entorno NODE_ENV=test después de aplicar migraciones y seed de 5 000 talleres.
-- Ejecutar como consulta SQL en una base aislada de pruebas; EXPLAIN ANALYZE sí ejecuta la consulta.
-- No ejecutar en producción ni durante las migraciones de aplicación.

EXPLAIN (ANALYZE, BUFFERS, SETTINGS)
SELECT
  w.id,
  w.slug,
  ST_Distance(
    w.location,
    ST_SetSRID(ST_MakePoint(-86.250, 12.136), 4326)::geography
  ) AS distance_meters,
  w.rating_average,
  w.rating_count
FROM public.workshops AS w
WHERE w.status = 'active'::public.workshop_status
  AND w.deleted_at IS NULL
  AND w.location IS NOT NULL
  AND ST_DWithin(
    w.location,
    ST_SetSRID(ST_MakePoint(-86.250, 12.136), 4326)::geography,
    5000
  )
ORDER BY
  distance_meters ASC,
  w.rating_average DESC,
  w.rating_count DESC,
  w.id ASC
LIMIT 50;

-- Criterio a registrar manualmente: Execution Time < 300 ms.
-- El plan debe mostrar uso del índice idx_workshops_location_gist (o Bitmap Index Scan sobre él).
