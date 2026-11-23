import type { PrismaClient } from '../../src/generated/prisma/client';
import { seedVehicleCatalogs } from './vehicle-catalog';
import { seedNicaraguaCatalogs } from './nicaragua-catalogs';

export async function seedDevelopment(prisma: PrismaClient): Promise<void> {
  await seedVehicleCatalogs(prisma);
  await seedNicaraguaCatalogs(prisma);
  console.info('Seeds de desarrollo: catálogos de vehículos, territorio, servicios y especialidades aplicados de forma idempotente.');
}
