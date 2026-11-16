import { FieldCryptoService } from '../../src/security/field-crypto.service';
import type { AppConfigService } from '../../src/config/config.module';

describe('FieldCryptoService — cifrado local de desarrollo/pruebas', () => {
  const config = {
    value: {
      nodeEnv: 'test',
      encryptionMode: 'local',
      awsRegion: 'us-east-1',
      localDataKeyBase64: Buffer.alloc(32, 7).toString('base64'),
      localBlindIndexKeyBase64: Buffer.alloc(32, 9).toString('base64'),
    },
  } as AppConfigService;

  it('cifra y descifra AES-256-GCM usando el propósito asociado', async () => {
    const service = new FieldCryptoService(config);
    const encrypted = await service.encrypt('+50588881234', 'users.phone');

    await expect(service.decrypt(encrypted, 'users.phone')).resolves.toBe('+50588881234');
    await expect(service.decrypt(encrypted, 'users.email')).rejects.toThrow();
    expect(encrypted.nonce).toHaveLength(12);
    expect(encrypted.tag).toHaveLength(16);
  });

  it('genera índices HMAC deterministas y separados por propósito', async () => {
    const service = new FieldCryptoService(config);
    const first = await service.blindIndex('+50588881234', 'users.phone');
    const repeated = await service.blindIndex('+50588881234', 'users.phone');
    const otherPurpose = await service.blindIndex('+50588881234', 'device_tokens.fcm_token');

    expect(first.digest.equals(repeated.digest)).toBe(true);
    expect(first.digest.equals(otherPurpose.digest)).toBe(false);
  });
});

describe('FieldCryptoService — AAD vinculada a la fila', () => {
  const config = {
    value: {
      nodeEnv: 'test', encryptionMode: 'local', awsRegion: 'us-east-1',
      localDataKeyBase64: Buffer.alloc(32, 17).toString('base64'),
      localBlindIndexKeyBase64: Buffer.alloc(32, 19).toString('base64'),
    },
  } as AppConfigService;

  it('cifra y descifra un número de póliza solo con el mismo usuario y registro', async () => {
    const service = new FieldCryptoService(config);
    const binding = { userId: 'user-1', recordId: 'policy-1' };
    const encrypted = await service.encrypt('POL-SECRET-2026', 'insurance_policies.policy_number', binding);
    expect(encrypted.aadVersion).toBe(2);
    await expect(service.decrypt(encrypted, 'insurance_policies.policy_number', binding)).resolves.toBe('POL-SECRET-2026');
    await expect(service.decrypt(encrypted, 'insurance_policies.policy_number', { userId: 'user-2', recordId: 'policy-1' })).rejects.toThrow();
    await expect(service.decrypt(encrypted, 'insurance_policies.policy_number', { userId: 'user-1', recordId: 'policy-2' })).rejects.toThrow();
    expect(encrypted.ciphertext.toString('utf8')).not.toContain('POL-SECRET-2026');
  });
});
