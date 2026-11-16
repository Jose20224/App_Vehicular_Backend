import { Injectable, InternalServerErrorException } from '@nestjs/common';
import {
  DecryptCommand,
  GenerateDataKeyCommand,
  GenerateMacCommand,
  KMSClient,
} from '@aws-sdk/client-kms';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { AppConfigService } from '../config/config.module';

export interface EncryptedField {
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
  encryptedDek: Buffer;
  keyVersion: string;
  aadVersion?: number;
}

export interface FieldBinding {
  userId: string;
  recordId: string;
}

@Injectable()
export class FieldCryptoService {
  private readonly kms?: KMSClient;
  private readonly contextBase: Record<string, string>;

  constructor(private readonly config: AppConfigService) {
    this.contextBase = {
      application: 'vehicular-api',
      environment: config.value.nodeEnv,
    };
    if (config.value.encryptionMode === 'kms') {
      this.kms = new KMSClient({ region: config.value.awsRegion });
    }
  }

  async encrypt(plaintext: string, purpose: string, binding?: FieldBinding): Promise<EncryptedField> {
    const aadVersion = binding ? 2 : 1;
    const context = {
      ...this.contextBase,
      purpose,
      ...(binding ? { user_id: binding.userId, record_id: binding.recordId } : {}),
    };
    const aad = aadVersion === 2
      ? Buffer.from(JSON.stringify(context), 'utf8')
      : Buffer.from(`${context.application}:${context.environment}:${purpose}`, 'utf8');
    let dataKey: Buffer;
    let encryptedDek: Buffer;
    let keyVersion: string;

    if (this.config.value.encryptionMode === 'kms') {
      if (!this.kms || !this.config.value.awsKmsKeyArn) {
        throw new InternalServerErrorException({
          code: 'ENCRYPTION_NOT_CONFIGURED',
          message: 'El cifrado de datos no está configurado correctamente.',
          details: {},
        });
      }
      const result = await this.kms.send(new GenerateDataKeyCommand({
        KeyId: this.config.value.awsKmsKeyArn,
        KeySpec: 'AES_256',
        EncryptionContext: context,
      }));
      if (!result.Plaintext || !result.CiphertextBlob || !result.KeyId) {
        throw new InternalServerErrorException({
          code: 'ENCRYPTION_FAILED',
          message: 'No fue posible proteger el dato sensible.',
          details: {},
        });
      }
      dataKey = Buffer.from(result.Plaintext);
      encryptedDek = Buffer.from(result.CiphertextBlob);
      keyVersion = result.KeyId;
    } else {
      const rawKey = this.config.value.localDataKeyBase64;
      if (!rawKey) throw new Error('LOCAL_DATA_KEY_BASE64 no está disponible.');
      dataKey = Buffer.from(rawKey, 'base64');
      encryptedDek = Buffer.from('local-development-key-v1', 'utf8');
      keyVersion = 'local-v1';
    }

    try {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', dataKey, nonce);
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return {
        ciphertext,
        nonce,
        tag: cipher.getAuthTag(),
        encryptedDek,
        keyVersion,
        aadVersion,
      };
    } finally {
      dataKey.fill(0);
    }
  }

  async decrypt(field: EncryptedField, purpose: string, binding?: FieldBinding): Promise<string> {
    const aadVersion = field.aadVersion ?? 1;
    if (aadVersion === 2 && !binding) throw new Error('El contexto de fila es obligatorio para descifrar este campo.');
    const context = {
      ...this.contextBase,
      purpose,
      ...(aadVersion === 2 && binding ? { user_id: binding.userId, record_id: binding.recordId } : {}),
    };
    const aad = aadVersion === 2
      ? Buffer.from(JSON.stringify(context), 'utf8')
      : Buffer.from(`${context.application}:${context.environment}:${purpose}`, 'utf8');
    let dataKey: Buffer;
    if (field.keyVersion === 'local-v1') {
      const rawKey = this.config.value.localDataKeyBase64;
      if (!rawKey || this.config.value.encryptionMode !== 'local') {
        throw new InternalServerErrorException({
          code: 'DECRYPTION_KEY_UNAVAILABLE',
          message: 'No está disponible la clave necesaria para leer el dato protegido.',
          details: {},
        });
      }
      dataKey = Buffer.from(rawKey, 'base64');
    } else {
      if (!this.kms) throw new Error('AWS KMS no está disponible.');
      const result = await this.kms.send(new DecryptCommand({
        CiphertextBlob: field.encryptedDek,
        KeyId: field.keyVersion,
        EncryptionContext: context,
      }));
      if (!result.Plaintext) throw new Error('KMS no devolvió una clave de datos.');
      dataKey = Buffer.from(result.Plaintext);
    }

    try {
      const decipher = createDecipheriv('aes-256-gcm', dataKey, field.nonce);
      decipher.setAAD(aad);
      decipher.setAuthTag(field.tag);
      return Buffer.concat([decipher.update(field.ciphertext), decipher.final()]).toString('utf8');
    } finally {
      dataKey.fill(0);
    }
  }

  async blindIndex(value: string, purpose: string): Promise<{ digest: Buffer; keyVersion: string }> {
    const message = Buffer.from(`${purpose}\u0000${value}`, 'utf8');
    if (this.config.value.encryptionMode === 'kms') {
      if (!this.kms || !this.config.value.awsKmsBlindIndexKeyArn) {
        throw new InternalServerErrorException({
          code: 'BLIND_INDEX_NOT_CONFIGURED',
          message: 'El índice protegido no está configurado correctamente.',
          details: {},
        });
      }
      const result = await this.kms.send(new GenerateMacCommand({
        KeyId: this.config.value.awsKmsBlindIndexKeyArn,
        MacAlgorithm: 'HMAC_SHA_256',
        Message: message,
      }));
      if (!result.Mac || !result.KeyId) throw new Error('KMS no devolvió un índice ciego.');
      return { digest: Buffer.from(result.Mac), keyVersion: result.KeyId };
    }

    const rawKey = this.config.value.localBlindIndexKeyBase64;
    if (!rawKey) throw new Error('LOCAL_BLIND_INDEX_KEY_BASE64 no está disponible.');
    return {
      digest: createHmac('sha256', Buffer.from(rawKey, 'base64')).update(message).digest(),
      keyVersion: 'local-hmac-v1',
    };
  }
}
