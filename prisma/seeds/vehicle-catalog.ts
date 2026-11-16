import { Prisma } from '../../src/generated/prisma/client';
import type { PrismaClient } from '../../src/generated/prisma/client';

const BRANDS = [
  { id: '10000000-0000-4000-8000-000000000001', name: 'Bajaj', sortOrder: 10 },
  { id: '10000000-0000-4000-8000-000000000002', name: 'Chevrolet', sortOrder: 20 },
  { id: '10000000-0000-4000-8000-000000000003', name: 'Ford', sortOrder: 30 },
  { id: '10000000-0000-4000-8000-000000000004', name: 'Honda', sortOrder: 40 },
  { id: '10000000-0000-4000-8000-000000000005', name: 'Hyundai', sortOrder: 50 },
  { id: '10000000-0000-4000-8000-000000000006', name: 'Kia', sortOrder: 60 },
  { id: '10000000-0000-4000-8000-000000000007', name: 'Mitsubishi', sortOrder: 70 },
  { id: '10000000-0000-4000-8000-000000000008', name: 'Nissan', sortOrder: 80 },
  { id: '10000000-0000-4000-8000-000000000009', name: 'Suzuki', sortOrder: 90 },
  { id: '10000000-0000-4000-8000-000000000010', name: 'Toyota', sortOrder: 100 },
  { id: '10000000-0000-4000-8000-000000000011', name: 'Yamaha', sortOrder: 110 },
] as const;

const MODELS = [
  ['Bajaj', 'Boxer 150', 'motorcycle'], ['Bajaj', 'Pulsar 150', 'motorcycle'],
  ['Chevrolet', 'Colorado', 'pickup'], ['Chevrolet', 'Spark', 'automobile'],
  ['Ford', 'Ranger', 'pickup'], ['Ford', 'Territory', 'automobile'],
  ['Honda', 'CB125F', 'motorcycle'], ['Honda', 'Civic', 'automobile'], ['Honda', 'XR150L', 'motorcycle'],
  ['Hyundai', 'Accent', 'automobile'], ['Hyundai', 'Tucson', 'automobile'],
  ['Kia', 'Rio', 'automobile'], ['Kia', 'Sportage', 'automobile'],
  ['Mitsubishi', 'L200', 'pickup'], ['Mitsubishi', 'Montero', 'automobile'],
  ['Nissan', 'Frontier', 'pickup'], ['Nissan', 'Sentra', 'automobile'],
  ['Suzuki', 'GN125', 'motorcycle'], ['Suzuki', 'Swift', 'automobile'],
  ['Toyota', 'Corolla', 'automobile'], ['Toyota', 'Hilux', 'pickup'], ['Toyota', 'Yaris', 'automobile'],
  ['Yamaha', 'FZ', 'motorcycle'], ['Yamaha', 'YBR125', 'motorcycle'],
] as const;

function normalize(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase('en-US');
}

export async function seedVehicleCatalogs(prisma: PrismaClient): Promise<void> {
  const brandIds = new Map<string, string>();
  for (const brand of BRANDS) {
    const normalizedName = normalize(brand.name);
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO public.vehicle_brands (id, name, normalized_name, is_active, sort_order)
      VALUES (${brand.id}::uuid, ${brand.name}, ${normalizedName}, TRUE, ${brand.sortOrder})
      ON CONFLICT (normalized_name) DO UPDATE SET
        name = EXCLUDED.name,
        is_active = TRUE,
        sort_order = EXCLUDED.sort_order,
        updated_at = clock_timestamp()
      WHERE public.vehicle_brands.name IS DISTINCT FROM EXCLUDED.name
        OR public.vehicle_brands.is_active IS DISTINCT FROM TRUE
        OR public.vehicle_brands.sort_order IS DISTINCT FROM EXCLUDED.sort_order
    `);
    const row = await prisma.vehicleBrand.findUnique({ where: { normalizedName } });
    if (row) brandIds.set(brand.name, row.id);
  }

  for (const [brandName, modelName, vehicleCategory] of MODELS) {
    const brandId = brandIds.get(brandName);
    if (!brandId) throw new Error(`No existe la marca requerida para el seed: ${brandName}.`);
    const normalizedName = normalize(modelName);
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO public.vehicle_models (id, brand_id, name, normalized_name, vehicle_category, is_active)
      VALUES (
        gen_random_uuid(), ${brandId}::uuid, ${modelName}, ${normalizedName}, ${vehicleCategory}, TRUE
      )
      ON CONFLICT (brand_id, normalized_name) DO UPDATE SET
        name = EXCLUDED.name,
        vehicle_category = EXCLUDED.vehicle_category,
        is_active = TRUE,
        updated_at = clock_timestamp()
      WHERE public.vehicle_models.name IS DISTINCT FROM EXCLUDED.name
        OR public.vehicle_models.vehicle_category IS DISTINCT FROM EXCLUDED.vehicle_category
        OR public.vehicle_models.is_active IS DISTINCT FROM TRUE
    `);
  }
}
