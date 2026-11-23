import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// `prisma generate` no necesita credenciales de migración. Los comandos
// migrate están protegidos por scripts/require-migration-url.cjs y CI.
const datasourceUrl = process.env.DATABASE_MIGRATION_URL
  ?? process.env.DATABASE_URL
  ?? 'postgresql://app_runtime:build-only@127.0.0.1:5432/build_only?schema=public';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'tsx prisma/seed.ts' },
  datasource: { url: datasourceUrl },
});
