import type { PrismaClient } from '../../src/generated/prisma/client';
import { seedVehicleCatalogs } from './vehicle-catalog';
import { seedNicaraguaCatalogs } from './nicaragua-catalogs';

export async function seedProduction(prisma: PrismaClient): Promise<void> {
  await seedVehicleCatalogs(prisma);
  await seedNicaraguaCatalogs(prisma);
  console.info('Seeds de producción: catálogo base de marcas/modelos aplicado; revisar actualizaciones antes de cada release.');
}
