import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { UsersService } from '../../src/modules/users/users.service';
import type { PrismaService } from '../../src/database/prisma.service';
import type { FieldCryptoService } from '../../src/security/field-crypto.service';
import type { AccountStorageCleanupService } from '../../src/security/account-storage-cleanup.service';

describe('UsersService — perfil y eliminación B1', () => {
  it('rechaza PATCH /me vacío', async () => {
    const service = new UsersService({} as PrismaService, {} as FieldCryptoService, {} as AccountStorageCleanupService);
    await expect(service.patchMe('user-1', {})).rejects.toBeInstanceOf(BadRequestException);
  });



  it('registra el token FCM cifrado y actualiza los metadatos del dispositivo', async () => {
    const tokenHash = Buffer.alloc(32, 7);
    const encrypted = {
      ciphertext: Buffer.from('cipher'), nonce: Buffer.alloc(12), tag: Buffer.alloc(16),
      encryptedDek: Buffer.from('dek'), keyVersion: 'local-v1',
    };
    const now = new Date();
    const tx = {
      syncDevice: {
        findFirst: jest.fn().mockResolvedValue({
          id: '018bcfe5-6800-7abc-8def-0123456789ab', userId: 'user-1', platform: 'android',
          deviceLabel: null, clientVersion: null,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      deviceToken: {
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({ createdAt: now, status: 'active', platform: 'android' }),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as PrismaService;
    const crypto = {
      blindIndex: jest.fn().mockResolvedValue({ digest: tokenHash, keyVersion: 'local-hmac-v1' }),
      encrypt: jest.fn().mockResolvedValue(encrypted),
    } as unknown as FieldCryptoService;
    const service = new UsersService(prisma, crypto, {} as AccountStorageCleanupService);

    const result = await service.registerDevice({
      id: 'user-1', role: 'user', device_id: '018bcfe5-6800-7abc-8def-0123456789ab',
    }, {
      device_id: '018bcfe5-6800-7abc-8def-0123456789ab', platform: 'android',
      fcm_token: 'fcm-token-example-long-enough-to-pass', device_label: 'Pixel', app_version: '1.2.0',
    });

    expect(tx.syncDevice.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ deviceLabel: 'Pixel', clientVersion: '1.2.0', lastSeenAt: expect.any(Date) }),
    }));
    expect(tx.deviceToken.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ tokenCiphertext: encrypted.ciphertext, tokenHash }),
    }));
    expect(result).toMatchObject({ device_id: '018bcfe5-6800-7abc-8def-0123456789ab', status: 'active' });
  });

  it('usa un update condicional para no reescribir el perfil durante deletion_pending', async () => {
    const prisma = {
      user: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as PrismaService;
    const service = new UsersService(prisma, {} as FieldCryptoService, {} as AccountStorageCleanupService);

    await expect(service.patchMe('user-1', { display_name: 'Nuevo nombre' })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.user.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'user-1', status: 'active', deletedAt: null },
    }));
  });

  it('elimina la identidad, revoca sesiones/dispositivos y devuelve el código de purga local', async () => {
    const tx = {
      refreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      reminder: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      notificationPreference: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      deviceToken: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      syncDevice: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      consentLog: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      emergencyContact: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      user: { update: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-1', status: 'active' }),
      },
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
    } as unknown as PrismaService;
    const storage = { deleteUserObjects: jest.fn().mockResolvedValue('deleted') } as unknown as AccountStorageCleanupService;
    const service = new UsersService(prisma, {} as FieldCryptoService, storage);

    const result = await service.deleteMe('user-1');

    expect(storage.deleteUserObjects).toHaveBeenCalledWith('user-1');
    expect(tx.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'user-1' },
      data: { status: 'deletion_pending', updatedAt: expect.any(Date) },
    }));
    expect(tx.refreshToken.updateMany).toHaveBeenCalled();
    expect(tx.deviceToken.updateMany).toHaveBeenCalled();
    expect(tx.syncDevice.updateMany).toHaveBeenCalled();
    expect(tx.consentLog.updateMany).toHaveBeenCalled();
    expect(tx.emergencyContact.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ phoneCiphertext: null, phoneHmac: null, deletedAt: expect.any(Date) }),
    }));
    expect(tx.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'user-1' },
      data: expect.objectContaining({ status: 'deleted', phoneCiphertext: null, deletedAt: expect.any(Date) }),
    }));
    expect(result).toMatchObject({ status: 'deleted', local_cleanup_code: 'LOCAL_DATA_PURGE_REQUIRED' });
  });

  it('mantiene deletion_pending cuando falla la limpieza S3 para permitir reintento', async () => {
    const tx = {
      user: { update: jest.fn().mockResolvedValue({}) },
      refreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      reminder: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      notificationPreference: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      deviceToken: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'user-1', status: 'active' }) },
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
    } as unknown as PrismaService;
    const storage = {
      deleteUserObjects: jest.fn().mockRejectedValue(new ServiceUnavailableException()),
    } as unknown as AccountStorageCleanupService;
    const service = new UsersService(prisma, {} as FieldCryptoService, storage);

    await expect(service.deleteMe('user-1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(tx.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: 'deletion_pending', updatedAt: expect.any(Date) },
    }));
    expect(tx.refreshToken.updateMany).toHaveBeenCalled();
    expect(tx.deviceToken.updateMany).toHaveBeenCalled();
  });
});
