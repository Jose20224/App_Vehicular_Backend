import { Prisma, type PrismaClient } from '../../src/generated/prisma/client';

const TEST_WORKSHOP_OWNER_ID = '00000000-0000-7000-8000-000000000101';
const TEST_WORKSHOP_COUNT = 5_000;

function uuidV7ForIndex(index: number): string {
  return `00000000-0000-7000-8000-${index.toString(16).padStart(12, '0')}`;
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

/**
 * 5 000 fichas sintéticas exclusivamente para NODE_ENV=test.
 * No forma parte de los seeds de desarrollo ni de producción.
 */
export async function seedWorkshopPerformanceFixtures(prisma: PrismaClient): Promise<void> {
  if (process.env.NODE_ENV !== 'test') throw new Error('Los 5 000 talleres sintéticos solo se permiten con NODE_ENV=test.');
  await prisma.user.upsert({
    where: { id: TEST_WORKSHOP_OWNER_ID },
    update: { role: 'workshop_owner', status: 'pending_verification', deletedAt: null, displayName: 'Propietario sintético de pruebas' },
    create: {
      id: TEST_WORKSHOP_OWNER_ID,
      displayName: 'Propietario sintético de pruebas',
      role: 'workshop_owner',
      // La cuenta sintética no necesita datos de contacto reales/cifrados.
      // pending_verification evita la constraint de teléfono activo de users.
      status: 'pending_verification',
    },
  });

  const department = await prisma.department.findFirst({ where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true } });
  if (!department) throw new Error('El seed de pruebas requiere al menos un departamento del catálogo de Nicaragua.');
  const municipality = await prisma.municipality.findFirst({
    where: { departmentId: department.id, isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true },
  });
  if (!municipality) throw new Error('El seed de pruebas requiere al menos un municipio activo.');

  const schedule = {
    monday: [{ open: '08:00', close: '17:00' }],
    tuesday: [{ open: '08:00', close: '17:00' }],
    wednesday: [{ open: '08:00', close: '17:00' }],
    thursday: [{ open: '08:00', close: '17:00' }],
    friday: [{ open: '08:00', close: '17:00' }],
    saturday: [{ open: '08:00', close: '12:00' }],
    sunday: [],
  } satisfies Prisma.InputJsonObject;
  const allIds = Array.from({ length: TEST_WORKSHOP_COUNT }, (_, index) => uuidV7ForIndex(index + 1));
  for (const idBatch of chunks(allIds, 500)) {
    const data = idBatch.map((id) => {
      const index = Number.parseInt(id.slice(-12), 16);
      return {
        id,
        userId: TEST_WORKSHOP_OWNER_ID,
        name: `Taller sintético ${index.toString().padStart(4, '0')}`,
        slug: `taller-sintetico-${index.toString().padStart(4, '0')}`,
        description: 'Ficha ficticia generada únicamente para pruebas de búsqueda geoespacial.',
        address: `Dirección sintética de prueba ${index}`,
        addressReferenceText: `Referencia local ficticia ${index}`,
        departmentId: department.id,
        municipalityId: municipality.id,
        weeklySchedule: schedule,
        ratingAverage: (index % 51) / 10,
        ratingCount: index % 180,
        status: 'draft' as const,
      };
    });
    await prisma.workshop.createMany({ data, skipDuplicates: true });
  }

  // Coordenadas deterministas alrededor de Managua. El estado se activa después
  // de poblar location para respetar el CHECK de integridad de fichas activas.
  const coordinateRows = allIds.map((id) => {
    const index = Number.parseInt(id.slice(-12), 16);
    const latitude = 12.136 + ((index % 100) * 0.00012);
    const longitude = -86.250 + ((Math.floor(index / 100) % 100) * 0.00012);
    return { id, latitude, longitude };
  });
  for (const batch of chunks(coordinateRows, 250)) {
    const values = batch.map((row) => Prisma.sql`(${row.id}::uuid, ${row.longitude}::double precision, ${row.latitude}::double precision)`);
    await prisma.$executeRaw(Prisma.sql`
      UPDATE public.workshops AS w
      SET location = ST_SetSRID(ST_MakePoint(v.longitude, v.latitude), 4326)::geography
      FROM (VALUES ${Prisma.join(values)}) AS v(id, longitude, latitude)
      WHERE w.id = v.id AND w.user_id = ${TEST_WORKSHOP_OWNER_ID}::uuid
    `);
  }
  await prisma.workshop.updateMany({
    where: { id: { in: allIds }, userId: TEST_WORKSHOP_OWNER_ID, deletedAt: null },
    data: { status: 'active', verifiedAt: new Date() },
  });

  console.info(`Seed de rendimiento B6 configurado: ${TEST_WORKSHOP_COUNT} talleres ficticios en entorno de pruebas.`);
}
