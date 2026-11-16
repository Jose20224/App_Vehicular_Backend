import { ConflictException } from '@nestjs/common';
import { EmergencyService } from '../../src/modules/emergency/emergency.service';
import type { PrismaService } from '../../src/database/prisma.service';
import type { FieldCryptoService } from '../../src/security/field-crypto.service';

describe('EmergencyService', () => {
  const userId = '0192f2a0-7d2a-7c11-9d5a-123456789ab1';
  const contactId = '0192f2a0-7d2a-7c11-9d5a-123456789ae1';

  it('rechaza el sexto contacto de emergencia', async () => {
    const tx = {
      emergencyContact: { count: jest.fn().mockResolvedValue(5), create: jest.fn(), updateMany: jest.fn() },
      $executeRaw: jest.fn(),
    };
    const prisma = {
      emergencyContact: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn((callback: (transaction: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaService;
    const crypto = {
      encrypt: jest.fn().mockResolvedValue({ ciphertext: Buffer.from('cipher'), nonce: Buffer.alloc(12), tag: Buffer.alloc(16), encryptedDek: Buffer.from('dek'), keyVersion: 'local-v1', aadVersion: 2 }),
      blindIndex: jest.fn().mockResolvedValue({ digest: Buffer.alloc(32), keyVersion: 'hmac-v1' }),
    } as unknown as FieldCryptoService;
    const service = new EmergencyService(prisma, crypto);

    await expect(service.createContact(userId, {
      id: contactId, name: 'Contacto seis', phone_e164: '+50588880000',
    })).rejects.toBeInstanceOf(ConflictException);
    expect(tx.emergencyContact.create).not.toHaveBeenCalled();
  });

  it('devuelve un mensaje de WhatsApp con mapa, referencia, vehículo y teléfono de la cuenta', async () => {
    const prisma = {
      user: { findFirst: jest.fn().mockResolvedValue({
        id: userId, displayName: 'Ana Pérez', phoneCiphertext: Buffer.from('cipher'),
        phoneNonce: Buffer.alloc(12), phoneTag: Buffer.alloc(16), phoneEncryptedDek: Buffer.from('dek'), phoneKeyVersion: 'local-v1',
      }) },
      vehicle: { findFirst: jest.fn().mockResolvedValue({
        id: 'vehicle-1', nickname: 'Mi moto', brandLabel: 'Yamaha', modelLabel: 'FZ', modelYear: 2022, vehicleType: 'motorcycle',
      }) },
    } as unknown as PrismaService;
    const crypto = { decrypt: jest.fn().mockResolvedValue('+50588881234') } as unknown as FieldCryptoService;
    const service = new EmergencyService(prisma, crypto);
    const result = await service.createShareMessage({ id: userId, role: 'user', device_id: 'device-1' }, {
      vehicle_id: 'vehicle-1', latitude: 12.136389, longitude: -86.251389,
      reference: 'Frente al parque, una cuadra al sur',
    });

    expect(result.map_url).toContain('12.136389,-86.251389');
    expect(result.message).toContain(String(result.map_url));
    expect(result.message).toContain('Frente al parque, una cuadra al sur');
    expect(result.message).toContain('+50588881234');
    expect(result.message).toContain('Yamaha FZ');
    expect(result.whatsapp_url).toContain('https://wa.me/?text=');
  });
});
