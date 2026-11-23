import type { PrismaClient } from '../../src/generated/prisma/client';
import { seedVehicleCatalogs } from './vehicle-catalog';
import { seedNicaraguaCatalogs } from './nicaragua-catalogs';
import { seedWorkshopPerformanceFixtures } from './workshops-test';

export async function seedTesting(prisma: PrismaClient): Promise<void> {
  if (process.env.NODE_ENV !== 'test') throw new Error('Los seeds de prueba requieren NODE_ENV=test.');
  await seedVehicleCatalogs(prisma);
  await seedNicaraguaCatalogs(prisma);
  await seedWorkshopPerformanceFixtures(prisma);
}
