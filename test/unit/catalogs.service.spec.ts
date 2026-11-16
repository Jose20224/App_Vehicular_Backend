import { CatalogsService } from '../../src/modules/catalogs/catalogs.service';
import type { PrismaService } from '../../src/database/prisma.service';

describe('CatalogsService', () => {
  it('devuelve versión y ETag estables para el catálogo de marcas', async () => {
    const prisma = {
      catalogVersion: { findUnique: jest.fn().mockResolvedValue({ version: 4n }) },
      vehicleBrand: { findMany: jest.fn().mockResolvedValue([{ id: 'brand-1', name: 'Toyota', sortOrder: 1 }]) },
      vehicleModel: { findMany: jest.fn() },
    } as unknown as PrismaService;
    const service = new CatalogsService(prisma);

    const result = await service.getVehicleCatalog('vehicle-brands');

    expect(result.etag).toBe('"vehicle-brands-4"');
    expect(result.catalogVersion).toBe('4');
    expect(result.items).toEqual([{ id: 'brand-1', name: 'Toyota', sort_order: 1 }]);
  });

  it('filtra modelos por marca cuando se proporciona brand_id', async () => {
    const prisma = {
      catalogVersion: { findUnique: jest.fn().mockResolvedValue({ version: 9n }) },
      vehicleBrand: { findMany: jest.fn() },
      vehicleModel: { findMany: jest.fn().mockResolvedValue([
        { id: 'model-1', brandId: '10000000-0000-4000-8000-000000000001', name: 'Corolla', vehicleCategory: 'automobile' },
      ]) },
    } as unknown as PrismaService;
    const service = new CatalogsService(prisma);

    const result = await service.getVehicleCatalog('vehicle-models', '10000000-0000-4000-8000-000000000001');

    expect(result.etag).toMatch(/^"vehicle-models-9-[a-f0-9]{12}"$/);
    expect(result.items).toHaveLength(1);
    expect(prisma.vehicleModel.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { isActive: true, brandId: '10000000-0000-4000-8000-000000000001' },
    }));
  });
});

it('devuelve aseguradoras como catálogo versionado y de solo lectura', async () => {
  const prisma = {
    catalogVersion: { findUnique: jest.fn().mockResolvedValue({ version: 3n }) },
    insurer: { findMany: jest.fn().mockResolvedValue([{ id: 'insurer-1', name: 'Aseguradora de prueba' }]) },
  } as unknown as PrismaService;
  const service = new CatalogsService(prisma);
  const result = await service.getVehicleCatalog('insurers');
  expect(result.etag).toBe('"insurers-3"');
  expect(result.items).toEqual([{ id: 'insurer-1', name: 'Aseguradora de prueba' }]);
});

describe('Catálogos de emergencia B5', () => {
  it('solo solicita números activos y verificados', async () => {
    const prisma = {
      catalogVersion: { findUnique: jest.fn().mockResolvedValue({ version: 6n }) },
      emergencyNumber: { findMany: jest.fn().mockResolvedValue([{ id: 'emergency-1', label: 'Ayuda verificada', category: 'other', phoneNumber: '118', sourceName: 'Fuente oficial', sourceUrl: null, verified: true, verifiedAt: new Date(), department: null, municipality: null }]) },
    } as unknown as PrismaService;
    const service = new CatalogsService(prisma);
    const result = await service.getCatalog('emergency-numbers');
    expect(prisma.emergencyNumber.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { isActive: true, verified: true },
    }));
    expect(result.etag).toBe('"emergency-numbers-6"');
  });

  it('concentra las versiones de todos los catálogos en un estado con ETag global', async () => {
    const prisma = {
      catalogVersion: { findMany: jest.fn().mockResolvedValue([{ catalogName: 'departments', version: 4n, updatedAt: new Date() }]) },
    } as unknown as PrismaService;
    const service = new CatalogsService(prisma);
    const result = await service.getCatalogStatus();
    expect(result.catalogs.departments.version).toBe('4');
    expect(result.catalogs['emergency-numbers'].version).toBe('0');
    expect(result.etag).toMatch(/^"catalog-status-/);
  });
});


describe('ETags de catálogos filtrados', () => {
  it('asigna ETags distintos a filtros diferentes del mismo catálogo', async () => {
    const prisma = {
      catalogVersion: { findUnique: jest.fn().mockResolvedValue({ version: 9n }) },
      vehicleModel: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const service = new CatalogsService(prisma);
    const first = await service.getCatalog('vehicle-models', { brandId: '10000000-0000-4000-8000-000000000001' });
    const second = await service.getCatalog('vehicle-models', { brandId: '10000000-0000-4000-8000-000000000002' });
    expect(first.etag).not.toBe(second.etag);
    expect(first.catalogVersion).toBe(second.catalogVersion);
  });
});

describe('Verificación de números de emergencia', () => {
  it('invalida la verificación al cambiar el teléfono o su alcance territorial', async () => {
    const existing = {
      id: 'emergency-1', label: 'Asistencia', category: 'police', phoneNumber: '118',
      departmentId: null, municipalityId: null, sourceName: 'Fuente anterior', sourceUrl: 'https://example.org',
      verified: true, verifiedAt: new Date('2026-01-01T00:00:00Z'), verifiedByUserId: 'admin-old',
    };
    const update = jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...existing, ...data }));
    const tx = { emergencyNumber: { update } };
    const prisma = {
      emergencyNumber: { findUnique: jest.fn().mockResolvedValue(existing) },
      $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
      department: { findUnique: jest.fn() },
      municipality: { findFirst: jest.fn() },
    } as unknown as PrismaService;
    const service = new CatalogsService(prisma);
    await service.updateEmergencyNumber('emergency-1', { phone_number: '119' }, 'admin-new');
    const firstUpdate = update.mock.calls[0][0];
    expect(update).toHaveBeenCalledTimes(1);
    expect(firstUpdate.data.verified).toBe(false);
    expect(firstUpdate.data.verifiedAt).toBeNull();
    expect(firstUpdate.data.verifiedByUserId).toBeNull();
    expect(firstUpdate.data.sourceName).toBeNull();
    expect(firstUpdate.data.sourceUrl).toBeNull();
  });

  it('invalida la verificación si cambia la fuente aunque el teléfono siga igual', async () => {
    const existing = {
      id: 'emergency-1', label: 'Asistencia', category: 'other', phoneNumber: '118',
      departmentId: null, municipalityId: null, sourceName: 'Fuente anterior', sourceUrl: 'https://example.org/old',
      verified: true, verifiedAt: new Date('2026-01-01T00:00:00Z'), verifiedByUserId: 'admin-old',
    };
    const update = jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...existing, ...data }));
    const tx = { emergencyNumber: { update } };
    const prisma = {
      emergencyNumber: { findUnique: jest.fn().mockResolvedValue(existing) },
      $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
      department: { findUnique: jest.fn() },
      municipality: { findFirst: jest.fn() },
    } as unknown as PrismaService;
    const service = new CatalogsService(prisma);
    await service.updateEmergencyNumber('emergency-1', { source_url: 'https://example.org/new' }, 'admin-new');
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].data).toEqual(expect.objectContaining({
      verified: false, verifiedAt: null, verifiedByUserId: null, sourceName: null,
    }));
  });

  it('revalida explícitamente después de invalidar datos en la misma transacción', async () => {
    const existing = {
      id: 'emergency-1', label: 'Asistencia', category: 'other', phoneNumber: '118',
      departmentId: null, municipalityId: null, sourceName: 'Fuente anterior', sourceUrl: null,
      verified: true, verifiedAt: new Date('2026-01-01T00:00:00Z'), verifiedByUserId: 'admin-old',
    };
    const update = jest.fn()
      .mockImplementationOnce(({ data }) => Promise.resolve({ ...existing, ...data, verified: false }))
      .mockImplementationOnce(({ data }) => Promise.resolve({ ...existing, phoneNumber: '119', sourceName: 'Fuente confirmada', ...data }));
    const tx = { emergencyNumber: { update } };
    const prisma = {
      emergencyNumber: { findUnique: jest.fn().mockResolvedValue(existing) },
      $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
      department: { findUnique: jest.fn() },
      municipality: { findFirst: jest.fn() },
    } as unknown as PrismaService;
    const service = new CatalogsService(prisma);
    const result = await service.updateEmergencyNumber('emergency-1', {
      phone_number: '119', verified: true, source_name: 'Fuente confirmada',
    }, 'admin-new');
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[0][0].data.verified).toBeUndefined();
    expect(update.mock.calls[1][0].data).toEqual(expect.objectContaining({
      verified: true, verifiedByUserId: 'admin-new',
    }));
    expect(result.verified).toBe(true);
  });
});
