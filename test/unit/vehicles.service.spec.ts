import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../src/generated/prisma/client';
import { VehiclesService } from '../../src/modules/vehicles/vehicles.service';
import type { PrismaService } from '../../src/database/prisma.service';

const USER_ID = '0192f2a0-7d2a-7c11-9d5a-123456789abc';
const VEHICLE_ID = '018bcfe5-6800-7abc-8def-0123456789ab';
type VehicleFixture = Prisma.VehicleGetPayload<{ include: typeof include }>;

function vehicleFixture(overrides: Partial<VehicleFixture> = {}): VehicleFixture {
  return {
    id: VEHICLE_ID,
    userId: USER_ID,
    plateCiphertext: Buffer.from('encrypted'),
    plateNonce: Buffer.alloc(12),
    plateTag: Buffer.alloc(16),
    plateEncryptedDek: Buffer.from('dek'),
    plateKeyVersion: 'local-v1',
    plateAadVersion: 1,
    plateHmac: Buffer.alloc(32, 1),
    plateHmacKeyVersion: 'local-hmac-v1',
    brandId: null,
    brandLabel: 'Toyota',
    modelId: null,
    modelLabel: 'Corolla',
    modelYear: 2022,
    color: 'Negro',
    vehicleType: 'automobile',
    nickname: null,
    vinCiphertext: null,
    vinNonce: null,
    vinTag: null,
    vinEncryptedDek: null,
    vinKeyVersion: null,
    vinAadVersion: null,
    vinHmac: null,
    vinHmacKeyVersion: null,
    mileageKm: 1200,
    photoStatus: 'none',
    photoObjectKey: null,
    photoPendingObjectKey: null,
    photoPendingMimeType: null,
    photoPendingSizeBytes: null,
    photoMimeType: null,
    photoSizeBytes: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
    syncVersion: 3n,
    brand: null,
    model: null,
    ...overrides,
  } as VehicleFixture;
}

function createHarness() {
  const record = vehicleFixture();
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    vehicle: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue(record),
    },
    vehicleBrand: { findFirst: jest.fn() },
    vehicleModel: { findFirst: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
    vehicle: {
      findFirst: jest.fn().mockResolvedValue(record),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const crypto = {
    encrypt: jest.fn().mockResolvedValue({
      ciphertext: Buffer.from('encrypted'), nonce: Buffer.alloc(12), tag: Buffer.alloc(16),
      encryptedDek: Buffer.from('dek'), keyVersion: 'local-v1', aadVersion: 2,
    }),
    blindIndex: jest.fn().mockResolvedValue({ digest: Buffer.alloc(32, 1), keyVersion: 'local-hmac-v1' }),
    decrypt: jest.fn().mockResolvedValue('M123456'),
  };
  const storage = {
    createUploadUrl: jest.fn(),
    createDownloadUrl: jest.fn(),
    headObject: jest.fn(),
    deleteObject: jest.fn(),
  };
  const config = { value: { maxVehiclesPerUser: 10, vehiclePhotoMaxBytes: 5 * 1024 * 1024 } };
  const service = new VehiclesService(
    prisma as unknown as PrismaService,
    crypto as never,
    storage as never,
    config as never,
  );
  return { service, prisma, tx, crypto, storage, record };
}

const createDto = {
  id: VEHICLE_ID,
  plate: 'M 123456',
  brand: 'Toyota',
  model: 'Corolla',
  model_year: 2022,
  vehicle_type: 'automobile' as const,
  color: 'Negro',
  nickname: null,
  vin: null,
  mileage_km: 1200,
};

describe('VehiclesService', () => {
  it('normaliza la placa, almacena el índice ciego y devuelve sync_version del servidor', async () => {
    const { service, crypto, tx } = createHarness();
    const result = await service.create(USER_ID, createDto);

    expect(crypto.encrypt).toHaveBeenCalledWith('M123456', 'vehicles.plate', { userId: USER_ID, recordId: VEHICLE_ID });
    expect(crypto.blindIndex).toHaveBeenCalledWith('M123456', 'vehicles.plate');
    expect(tx.vehicle.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ plateHmac: Buffer.alloc(32, 1), userId: USER_ID, id: VEHICLE_ID }),
    }));
    expect(result).toEqual(expect.objectContaining({ plate: 'M123456', sync_version: '3' }));
  });

  it('repite la misma creación con el mismo UUID sin duplicar el registro', async () => {
    const { service, tx } = createHarness();
    const record = vehicleFixture();
    tx.vehicle.findUnique.mockResolvedValue(record);

    const result = await service.create(USER_ID, createDto);

    expect(tx.vehicle.create).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ id: VEHICLE_ID, idempotent_replay: true }));
  });

  it('rechaza una placa activa duplicada del mismo usuario', async () => {
    const { service, tx } = createHarness();
    tx.vehicle.findFirst.mockResolvedValue({ id: 'otro-vehiculo' });

    await expect(service.create(USER_ID, createDto)).rejects.toBeInstanceOf(ConflictException);
    expect(tx.vehicle.create).not.toHaveBeenCalled();
  });

  it('aplica el máximo configurable de vehículos activos', async () => {
    const { service, tx } = createHarness();
    tx.vehicle.count.mockResolvedValue(10);

    await expect(service.create(USER_ID, createDto)).rejects.toBeInstanceOf(ConflictException);
    expect(tx.vehicle.create).not.toHaveBeenCalled();
  });

  it('filtra la lectura por dueño y oculta recursos ajenos como 404', async () => {
    const { service, prisma } = createHarness();
    prisma.vehicle.findFirst.mockResolvedValue(null);

    await expect(service.getOne(USER_ID, VEHICLE_ID)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.vehicle.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: VEHICLE_ID, userId: USER_ID, deletedAt: null },
    }));
  });

  it('no permite reutilizar el UUID de un vehículo eliminado', async () => {
    const { service, tx } = createHarness();
    tx.vehicle.findUnique.mockResolvedValue(vehicleFixture({ deletedAt: new Date('2026-02-01T00:00:00.000Z') }));

    await expect(service.create(USER_ID, createDto)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'VEHICLE_ID_RETIRED' }),
    });
    expect(tx.vehicle.create).not.toHaveBeenCalled();
  });

  it('guarda metadatos pendientes y entrega URL firmada sin exponer la key S3', async () => {
    const { service, prisma, storage } = createHarness();
    storage.createUploadUrl.mockResolvedValue({
      url: 'https://s3.example.invalid/signed',
      expiresInSeconds: 300,
      requiredHeaders: { 'Content-Type': 'image/jpeg', 'Content-Length': '2048' },
      simulated: false,
    });

    const result = await service.createPhotoUploadUrl(USER_ID, VEHICLE_ID, {
      content_type: 'image/jpeg',
      size_bytes: 2048,
    });

    expect(result).toEqual(expect.objectContaining({ vehicle_id: VEHICLE_ID, photo_status: 'pending_upload' }));
    expect(result).not.toHaveProperty('object_key');
    expect(prisma.vehicle.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: VEHICLE_ID, userId: USER_ID, deletedAt: null },
      data: expect.objectContaining({ photoStatus: 'pending_upload', photoPendingSizeBytes: 2048n }),
    }));
  });

  it('confirma una foto solo después de verificar tamaño y MIME en almacenamiento', async () => {
    const { service, prisma, storage, record } = createHarness();
    const pending = vehicleFixture({
      photoStatus: 'pending_upload',
      photoPendingObjectKey: 'users/u/vehicles/v/photos/random',
      photoPendingMimeType: 'image/jpeg',
      photoPendingSizeBytes: 2048n,
    });
    const confirmed = vehicleFixture({
      photoStatus: 'available',
      photoObjectKey: 'users/u/vehicles/v/photos/random',
      photoMimeType: 'image/jpeg',
      photoSizeBytes: 2048n,
    });
    prisma.vehicle.findFirst.mockResolvedValueOnce(pending).mockResolvedValueOnce(confirmed);
    storage.headObject.mockResolvedValue({ contentLength: 2048, contentType: 'image/jpeg' });
    storage.createDownloadUrl.mockResolvedValue({ url: 'https://s3.example.invalid/read', expiresInSeconds: 600 });

    const result = await service.confirmPhotoUpload(USER_ID, VEHICLE_ID);

    expect(storage.headObject).toHaveBeenCalledWith(pending.photoPendingObjectKey);
    expect(prisma.vehicle.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ photoPendingObjectKey: pending.photoPendingObjectKey }),
      data: expect.objectContaining({ photoStatus: 'available', photoObjectKey: pending.photoPendingObjectKey }),
    }));
    expect(result).toEqual(expect.objectContaining({ photo_status: 'available', photo_url: 'https://s3.example.invalid/read' }));
    expect(record.id).toBe(VEHICLE_ID);
  });

  it('incluye el propietario en el filtro de toda actualización', async () => {
    const { service, prisma } = createHarness();

    await service.update(USER_ID, VEHICLE_ID, { nickname: 'Vehículo familiar' });

    expect(prisma.vehicle.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: VEHICLE_ID, userId: USER_ID, deletedAt: null },
    }));
  });

  it('rechaza reutilizar un UUID de vehículo con payload distinto', async () => {
    const { service, tx } = createHarness();
    tx.vehicle.findUnique.mockResolvedValue(vehicleFixture({ color: 'Blanco' }));

    await expect(service.create(USER_ID, createDto)).rejects.toBeInstanceOf(ConflictException);
    expect(tx.vehicle.create).not.toHaveBeenCalled();
  });
});
