/** Metadatos comunes de tablas propiedad del usuario y editables offline. */
export interface SyncReadyMetadata {
  id: string; // UUID v7 generado por el cliente.
  user_id: string; // Propietario; toda consulta debe filtrar por este campo.
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  sync_version: bigint; // Asignado únicamente por el trigger PostgreSQL.
}

/** Objetos SQL compartidos. La asignación real ocurre exclusivamente en PostgreSQL. */
export const SYNC_VERSION_SEQUENCE = 'public.sync_version_seq';
export const SYNC_METADATA_TRIGGER_FUNCTION = 'public.assign_sync_metadata';

/**
 * Columnas comunes para la migración de cada tabla sync-ready.
 * Cada tabla añade FK de user_id a su tabla de propietario e índice user_id.
 */
export const SYNC_READY_METADATA_COLUMNS = `
  user_id UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  deleted_at TIMESTAMPTZ(6) NULL,
  sync_version BIGINT NOT NULL DEFAULT 0
`;

/** CHECK sugerido para exigir UUID v7/variant RFC 9562 en PostgreSQL 16. */
export const UUID_V7_CHECK_SQL = `
  CHECK (
    substring(id::text FROM 15 FOR 1) = '7'
    AND substring(id::text FROM 20 FOR 1) IN ('8', '9', 'a', 'b')
  )
`;

/**
 * Regla para migraciones futuras:
 * - definir id UUID PRIMARY KEY y UUID_V7_CHECK_SQL;
 * - incluir SYNC_READY_METADATA_COLUMNS y FK a la tabla propietaria;
 * - crear índice B-tree por user_id;
 * - adjuntar prisma/templates/sync-ready-trigger.sql;
 * - nunca asignar sync_version desde NestJS ni aceptar su valor desde DTO.
 */
