import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { seedDevelopment } from './seeds/development';
import { seedTesting } from './seeds/testing';
import { seedProduction } from './seeds/production';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_MIGRATION_URL;
  if (!databaseUrl) throw new Error('DATABASE_MIGRATION_URL es obligatoria para ejecutar seeds.');
  const parsedUrl = new URL(databaseUrl);
  if (decodeURIComponent(parsedUrl.username) !== 'app_migrator') {
    throw new Error('Los seeds de catálogos deben ejecutarse con el rol app_migrator, nunca con app_runtime.');
  }

  const adapter = new PrismaPg({ connectionString: databaseUrl, max: 2 });
  const prisma = new PrismaClient({ adapter });

  try {
    switch (process.env.NODE_ENV) {
      case 'development':
        await seedDevelopment(prisma);
        break;
      case 'test':
        await seedTesting(prisma);
        break;
      case 'production':
        if (process.env.ALLOW_PRODUCTION_SEED !== 'true') {
          throw new Error('En producción se requiere ALLOW_PRODUCTION_SEED=true de forma explícita.');
        }
        await seedProduction(prisma);
        break;
      default:
        throw new Error('NODE_ENV debe definirse antes de ejecutar seeds.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error('Falló la ejecución de seeds.', error);
  process.exitCode = 1;
});
