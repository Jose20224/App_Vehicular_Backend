import { DocumentsService } from '../../src/modules/documents/documents.service';
import type { PrismaService } from '../../src/database/prisma.service';
import type { FieldCryptoService } from '../../src/security/field-crypto.service';
import type { ObjectStorageService } from '../../src/storage/object-storage.service';
import type { AppConfigService } from '../../src/config/config.module';

describe('DocumentsService — validación y ciclo de archivos', () => {
  const config = { value: { nodeEnv: 'test', documentExpiringSoonDays: 30, awsS3PresignUploadTtlSeconds: 300 } } as AppConfigService;

  it('rechaza archivos superiores a 10 MB antes de pedir una URL firmada', async () => {
    const storage = { createUploadUrl: jest.fn() } as unknown as ObjectStorageService;
    const prisma = {} as PrismaService;
    const service = new DocumentsService(prisma, {} as FieldCryptoService, storage, config, { regenerateForDocument: jest.fn().mockResolvedValue(undefined), cancelForDocument: jest.fn().mockResolvedValue(undefined) } as never);
    await expect(service.createUploadUrl('user-1', 'doc-1', {
      content_type: 'application/pdf', size_bytes: 10 * 1024 * 1024 + 1,
    })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'DOCUMENT_FILE_TOO_LARGE' }) });
    expect(storage.createUploadUrl).not.toHaveBeenCalled();
  });

  it('rechaza un formato no permitido antes de consultar el documento', async () => {
    const storage = { createUploadUrl: jest.fn() } as unknown as ObjectStorageService;
    const prisma = { vehicleDocument: { findFirst: jest.fn() } } as unknown as PrismaService;
    const service = new DocumentsService(prisma, {} as FieldCryptoService, storage, config, { regenerateForDocument: jest.fn().mockResolvedValue(undefined), cancelForDocument: jest.fn().mockResolvedValue(undefined) } as never);
    await expect(service.createUploadUrl('user-1', 'doc-1', {
      content_type: 'application/zip', size_bytes: 1024,
    })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'DOCUMENT_FILE_TYPE_NOT_ALLOWED' }) });
    expect(prisma.vehicleDocument.findFirst).not.toHaveBeenCalled();
  });

  it('no reemite una URL vigente para la misma key y evita que un PUT anterior sobrescriba el archivo confirmado', async () => {
    const prisma = { vehicleDocument: { findFirst: jest.fn().mockResolvedValue({
      id: 'doc-1', userId: 'user-1', vehicleId: 'vehicle-1', fileStatus: 'pendiente_subida', deletedAt: null,
      pendingObjectKey: 'users/u/v/documents/old-random-key', pendingContentType: 'application/pdf',
      pendingSizeBytes: 1024n, pendingUrlIssuedAt: new Date(),
    }) } } as unknown as PrismaService;
    const storage = { createUploadUrl: jest.fn() } as unknown as ObjectStorageService;
    const service = new DocumentsService(prisma, {} as FieldCryptoService, storage, config, { regenerateForDocument: jest.fn().mockResolvedValue(undefined), cancelForDocument: jest.fn().mockResolvedValue(undefined) } as never);
    await expect(service.createUploadUrl('user-1', 'doc-1', {
      content_type: 'application/pdf', size_bytes: 1024,
    })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'DOCUMENT_UPLOAD_ALREADY_PENDING' }) });
    expect(storage.createUploadUrl).not.toHaveBeenCalled();
  });

  it('no marca disponible un documento que todavía no inició la subida', async () => {
    const prisma = {
      vehicleDocument: { findFirst: jest.fn().mockResolvedValue({
        id: 'doc-1', userId: 'user-1', vehicleId: 'vehicle-1', fileStatus: 'pendiente_subida',
        pendingObjectKey: null, pendingContentType: null, pendingSizeBytes: null, deletedAt: null,
      }) },
    } as unknown as PrismaService;
    const storage = { headObject: jest.fn(), getObjectPrefix: jest.fn() } as unknown as ObjectStorageService;
    const service = new DocumentsService(prisma, {} as FieldCryptoService, storage, config, { regenerateForDocument: jest.fn().mockResolvedValue(undefined), cancelForDocument: jest.fn().mockResolvedValue(undefined) } as never);
    await expect(service.confirmUpload('user-1', 'doc-1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DOCUMENT_UPLOAD_NOT_STARTED' }),
    });
    expect(storage.headObject).not.toHaveBeenCalled();
  });

  it('no permite consultar un documento que no pertenece al usuario autenticado', async () => {
  const prisma = { vehicleDocument: { findFirst: jest.fn().mockResolvedValue(null) } } as unknown as PrismaService;
  const service = new DocumentsService(prisma, {} as FieldCryptoService, {} as ObjectStorageService, config, { regenerateForDocument: jest.fn().mockResolvedValue(undefined), cancelForDocument: jest.fn().mockResolvedValue(undefined) } as never);
  await expect(service.getOne('user-2', 'document-user-1')).rejects.toMatchObject({
    response: expect.objectContaining({ code: 'DOCUMENT_NOT_FOUND' }),
  });
  expect(prisma.vehicleDocument.findFirst).toHaveBeenCalledWith({
    where: { id: 'document-user-1', userId: 'user-2', deletedAt: null },
  });
});

it('verifica la firma mágica PDF y solo entonces confirma file_status disponible', async () => {
  const doc = {
    id: 'doc-1', userId: 'user-1', vehicleId: 'vehicle-1', documentType: 'poliza', title: 'Póliza',
    issuerName: null, validFrom: null, validUntil: null, fileStatus: 'pendiente_subida',
    pendingObjectKey: 'users/u/v/documents/random', pendingContentType: 'application/pdf',
    pendingSizeBytes: 1024n, pendingUrlIssuedAt: new Date(), fileObjectKey: null, fileContentType: null, fileSizeBytes: null,
    createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'), deletedAt: null, syncVersion: 1n,
  };
  const updated = { ...doc, fileStatus: 'disponible', fileObjectKey: doc.pendingObjectKey,
    fileContentType: 'application/pdf', fileSizeBytes: 1024n, pendingObjectKey: null,
    pendingContentType: null, pendingSizeBytes: null, pendingUrlIssuedAt: null };
  const prisma = {
    vehicleDocument: {
      findFirst: jest.fn().mockResolvedValue(doc),
      update: jest.fn().mockResolvedValue(updated),
    },
  } as unknown as PrismaService;
  const storage = {
    headObject: jest.fn().mockResolvedValue({ contentLength: 1024, contentType: 'application/pdf' }),
    getObjectPrefix: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.7')),
  } as unknown as ObjectStorageService;
  const service = new DocumentsService(prisma, {} as FieldCryptoService, storage, config, { regenerateForDocument: jest.fn().mockResolvedValue(undefined), cancelForDocument: jest.fn().mockResolvedValue(undefined) } as never);
  const result = await service.confirmUpload('user-1', 'doc-1');
  expect(result.file_status).toBe('disponible');
  expect(prisma.vehicleDocument.update).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ fileStatus: 'disponible', fileContentType: 'application/pdf' }),
  }));
});

it('rechaza contenido cuyo tipo real no coincide con el MIME declarado', async () => {
  const doc = {
    id: 'doc-1', userId: 'user-1', vehicleId: 'vehicle-1', fileStatus: 'pendiente_subida',
    pendingObjectKey: 'users/u/v/documents/random', pendingContentType: 'application/pdf', pendingSizeBytes: 1024n,
  };
  const prisma = { vehicleDocument: { findFirst: jest.fn().mockResolvedValue(doc), update: jest.fn() } } as unknown as PrismaService;
  const storage = {
    headObject: jest.fn().mockResolvedValue({ contentLength: 1024, contentType: 'application/pdf' }),
    getObjectPrefix: jest.fn().mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
  } as unknown as ObjectStorageService;
  const service = new DocumentsService(prisma, {} as FieldCryptoService, storage, config, { regenerateForDocument: jest.fn().mockResolvedValue(undefined), cancelForDocument: jest.fn().mockResolvedValue(undefined) } as never);
  await expect(service.confirmUpload('user-1', 'doc-1')).rejects.toMatchObject({
    response: expect.objectContaining({ code: 'DOCUMENT_FILE_TYPE_NOT_ALLOWED' }),
  });
  expect(prisma.vehicleDocument.update).not.toHaveBeenCalled();
});

  it('renueva una póliza archivando la anterior y conserva la relación histórica', async () => {
    const userId = '0192f2a0-7d2a-7c11-9d5a-123456789abc';
    const vehicleId = '0192f2a0-7d2a-7c11-9d5a-123456789abd';
    const policyId = '0192f2a0-7d2a-7c11-9d5a-123456789abe';
    const documentId = '0192f2a0-7d2a-7c11-9d5a-123456789abf';
    const previous = { id: '0192f2a0-7d2a-7c11-9d5a-123456789ac0' };
    const createdAt = new Date('2026-11-04T12:00:00Z');
    const document = {
      id: documentId, userId, vehicleId, documentType: 'poliza', title: 'Póliza renovada',
      issuerName: 'Otra aseguradora', validFrom: new Date('2026-11-01T00:00:00Z'),
      validUntil: new Date('2027-10-31T00:00:00Z'), fileStatus: 'pendiente_subida',
      fileObjectKey: null, pendingObjectKey: null, pendingContentType: null, pendingSizeBytes: null,
      fileContentType: null, fileSizeBytes: null, originalFileName: null, insurancePolicyId: policyId,
      createdAt, updatedAt: createdAt, deletedAt: null, syncVersion: 22n,
    };
    const createdPolicy = {
      id: policyId, userId, vehicleId, insurerId: null, otherInsurerName: 'Otra aseguradora',
      policyNumberCiphertext: Buffer.from('ciphertext-not-plaintext'), policyNumberNonce: Buffer.alloc(12),
      policyNumberTag: Buffer.alloc(16), policyNumberEncryptedDek: Buffer.from('wrapped-dek'),
      policyNumberKeyVersion: 'local-v1', policyNumberAadVersion: 2,
      validFrom: new Date('2026-11-01T00:00:00Z'), validUntil: new Date('2027-10-31T00:00:00Z'),
      deductible: { toString: () => '0' }, premium: null, currency: 'USD',
      claimsPhoneCiphertext: null, claimsPhoneNonce: null, claimsPhoneTag: null,
      claimsPhoneEncryptedDek: null, claimsPhoneKeyVersion: null, claimsPhoneAadVersion: null, status: 'active',
      previousPolicyId: previous.id, archivedAt: null, createdAt, updatedAt: createdAt,
      deletedAt: null, syncVersion: 23n, insurer: null, document,
    };
    const tx = {
      insurancePolicy: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(previous),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue(createdPolicy),
      },
      vehicleDocument: { findUnique: jest.fn().mockResolvedValue({ id: 'previous-doc' }) },
      reminder: { updateMany: jest.fn().mockResolvedValue({ count: 0 }), createMany: jest.fn().mockResolvedValue({ count: 0 }) },
      notificationPreference: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const prisma = {
      vehicle: { findFirst: jest.fn().mockResolvedValue({ id: vehicleId }) },
      $transaction: jest.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaService;
    const crypto = {
      encrypt: jest.fn().mockResolvedValue({ ciphertext: Buffer.from('ciphertext-not-plaintext'), nonce: Buffer.alloc(12),
        tag: Buffer.alloc(16), encryptedDek: Buffer.from('wrapped-dek'), keyVersion: 'local-v1', aadVersion: 2 }),
      decrypt: jest.fn().mockResolvedValue('POL-2026-NEW'),
    } as unknown as FieldCryptoService;
    const service = new DocumentsService(prisma, crypto, {} as ObjectStorageService, config, { regenerateForDocument: jest.fn().mockResolvedValue(undefined), cancelForDocument: jest.fn().mockResolvedValue(undefined) } as never);

    const result = await service.createPolicy(userId, vehicleId, {
      id: policyId, document_id: documentId, other_insurer_name: 'Otra aseguradora',
      policy_number: 'POL-2026-NEW', valid_from: '2026-11-01', valid_until: '2027-10-31',
      deductible: 0, currency: 'USD',
    });

    expect(tx.insurancePolicy.update).toHaveBeenCalledWith({
      where: { id: previous.id }, data: expect.objectContaining({ status: 'archived', archivedAt: expect.any(Date) }),
    });
    expect(tx.insurancePolicy.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ previousPolicyId: previous.id, policyNumberAadVersion: 2,
        policyNumberCiphertext: Buffer.from('ciphertext-not-plaintext'), document: { create: expect.objectContaining({ id: documentId }) } }),
    }));
    expect(result).toEqual(expect.objectContaining({ id: policyId, previous_policy_id: previous.id,
      policy_number: 'POL-2026-NEW', document: expect.objectContaining({ file_status: 'pendiente_subida' }) }));
  });
});
