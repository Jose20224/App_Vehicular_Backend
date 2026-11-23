import { ProvidersService } from '../../src/modules/providers/providers.service';
import { MockAssistanceNotificationAdapter } from '../../src/modules/providers/assistance-notification.adapter';
import type { PrismaService } from '../../src/database/prisma.service';
import type { FieldCryptoService } from '../../src/security/field-crypto.service';
import type { RedisService } from '../../src/redis/redis.service';
import type { AppConfigService } from '../../src/config/config.module';
import type { AssistanceQueueService } from '../../src/modules/providers/assistance-queue.service';
import type { AssistanceRateLimitService } from '../../src/modules/providers/assistance-rate-limit.service';

describe('B7 assistance notification dispatch', () => {
  it('sends the request details and a GPS map link through the mock adapter', async () => {
    const tx = {
      assistanceActionToken: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      assistanceRequest: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      assistanceRequestEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      assistanceRequest: {
        findFirst: jest.fn().mockResolvedValue({
          id: '018bcfe5-7b2a-7cc1-98c4-dc0c0c0c0c01',
          userId: '018bcfe5-7b2a-7cc1-98c4-dc0c0c0c0c02',
          status: 'created',
          issueDescription: 'El vehículo no arranca',
          addressReferenceText: 'Frente al parque, una cuadra al sur',
          contactPhoneCiphertext: null,
          contactPhoneNonce: null,
          contactPhoneTag: null,
          contactPhoneEncryptedDek: null,
          contactPhoneKeyVersion: null,
          contactPhoneAadVersion: null,
          serviceTypeId: '018bcfe5-7b2a-7cc1-98c4-dc0c0c0c0c03',
          user: {
            id: '018bcfe5-7b2a-7cc1-98c4-dc0c0c0c0c02',
            displayName: 'Conductor de prueba',
            phoneCiphertext: null, phoneNonce: null, phoneTag: null,
            phoneEncryptedDek: null, phoneKeyVersion: null,
          },
          serviceType: { name: 'Grúa' },
          vehicle: { nickname: 'Mi carro', brandLabel: 'Toyota', modelLabel: 'Yaris', modelYear: 2015, vehicleType: 'car' },
        }),
        updateMany: jest.fn(),
      },
      assistanceProvider: {
        findFirst: jest.fn().mockResolvedValue({
          id: '018bcfe5-7b2a-7cc1-98c4-dc0c0c0c0c04',
          userId: '018bcfe5-7b2a-7cc1-98c4-dc0c0c0c0c05',
          phoneCiphertext: Buffer.from('phone-ciphertext'), phoneNonce: Buffer.from('nonce'),
          phoneTag: Buffer.from('tag'), phoneEncryptedDek: Buffer.from('dek'), phoneKeyVersion: 'test-key', phoneAadVersion: 2,
          whatsappCiphertext: Buffer.from('whatsapp-ciphertext'), whatsappNonce: Buffer.from('nonce'),
          whatsappTag: Buffer.from('tag'), whatsappEncryptedDek: Buffer.from('dek'), whatsappKeyVersion: 'test-key', whatsappAadVersion: 2,
        }),
      },
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{ latitude: 12.136389, longitude: -86.251389 }])
        .mockResolvedValueOnce([{ id: '018bcfe5-7b2a-7cc1-98c4-dc0c0c0c0c04' }]),
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    const crypto = { decrypt: jest.fn()
      .mockResolvedValueOnce('+50588887777')
      .mockResolvedValueOnce('+50588886666') };
    const adapter = new MockAssistanceNotificationAdapter();
    const send = jest.spyOn(adapter, 'send');
    const config = { value: {
      assistanceActionTokenTtlSeconds: 86_400,
      publicApiBaseUrl: 'https://api.example.test/api/v1',
      appPort: 3000,
      apiPrefix: 'api/v1',
    } };
    const service = new ProvidersService(
      prisma as unknown as PrismaService,
      crypto as unknown as FieldCryptoService,
      {} as RedisService,
      config as AppConfigService,
      {} as AssistanceRateLimitService,
      {} as AssistanceQueueService,
      adapter,
    );

    const result = await service.dispatchRequestNotification('018bcfe5-7b2a-7cc1-98c4-dc0c0c0c0c01');

    expect(result).toMatchObject({ sent: true, notification_provider: 'mock', channel: 'whatsapp' });
    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0][0];
    expect(message.to).toBe('+50588886666');
    expect(message.body).toContain('Solicitante: Conductor de prueba');
    expect(message.body).toContain('Servicio: Grúa');
    expect(message.body).toContain('Referencia: Frente al parque, una cuadra al sur');
    expect(message.body).toContain('https://www.google.com/maps/search/?api=1&query=12.136389,-86.251389');
    expect(message.body).toContain('/assistance-actions/');
    expect(message.body).toContain('de un solo uso');
  });
});
