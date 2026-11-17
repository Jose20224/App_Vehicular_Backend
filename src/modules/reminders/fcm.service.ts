import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { AppConfigService } from '../../config/config.module';
import { FieldCryptoService } from '../../security/field-crypto.service';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class FcmService implements OnModuleInit {
  private readonly logger = new Logger(FcmService.name);
  private app?: App;

  constructor(private readonly config: AppConfigService, private readonly prisma: PrismaService, private readonly crypto: FieldCryptoService) {}

  onModuleInit(): void {
    if (this.config.value.fcmMode !== 'firebase') return;
    const credentials = JSON.parse(Buffer.from(this.config.value.firebaseServiceAccountBase64!, 'base64').toString('utf8'));
    this.app = getApps().find((app) => app.name === 'vehicular-api') ?? initializeApp({
      credential: cert(credentials), projectId: this.config.value.firebaseProjectId,
    }, 'vehicular-api');
  }

  async sendToUser(userId: string, reminderId: string, title: string, body: string): Promise<{ sent: number; failedCount: number; invalidTokenIds: string[]; messageIds: string[] }> {
    const tokens = await this.prisma.deviceToken.findMany({
      where: { userId, status: 'active', tokenCiphertext: { not: null }, tokenNonce: { not: null }, tokenTag: { not: null }, tokenEncryptedDek: { not: null }, tokenKeyVersion: { not: null } },
      select: { id: true, userId: true, tokenCiphertext: true, tokenNonce: true, tokenTag: true, tokenEncryptedDek: true, tokenKeyVersion: true, tokenAadVersion: true },
    });
    const invalidTokenIds: string[] = [];
    const messageIds: string[] = [];
    let sent = 0;
    let failedCount = 0;
    for (const token of tokens) {
      const value = await this.crypto.decrypt({
        ciphertext: Buffer.from(token.tokenCiphertext!), nonce: Buffer.from(token.tokenNonce!),
        tag: Buffer.from(token.tokenTag!), encryptedDek: Buffer.from(token.tokenEncryptedDek!),
        keyVersion: token.tokenKeyVersion!, aadVersion: token.tokenAadVersion ?? 1,
      }, 'device_tokens.fcm_token', (token.tokenAadVersion ?? 1) >= 2 ? { userId: token.userId, recordId: token.id } : undefined);
      if (this.config.value.fcmMode === 'mock') {
        sent += 1;
        messageIds.push(`mock:${reminderId}:${token.id}`);
        continue;
      }
      try {
        const id = await getMessaging(this.app!).send({
          token: value,
          notification: { title, body },
          data: { reminder_id: reminderId },
          android: { collapseKey: `reminder-${reminderId}` },
          apns: { headers: { 'apns-collapse-id': `reminder-${reminderId}` } },
        });
        sent += 1;
        messageIds.push(id);
      } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'FCM_SEND_FAILED';
        if (['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(code)) invalidTokenIds.push(token.id);
        else { failedCount += 1; this.logger.warn(`FCM temporal failure (${code}).`); }
      }
    }
    if (invalidTokenIds.length) {
      await this.prisma.deviceToken.updateMany({ where: { id: { in: invalidTokenIds }, userId }, data: { status: 'invalid', tokenCiphertext: null, tokenNonce: null, tokenTag: null, tokenEncryptedDek: null, tokenKeyVersion: null, tokenAadVersion: null, tokenHash: null, tokenHmacKeyVersion: null, revokedAt: new Date(), updatedAt: new Date() } });
    }
    if (failedCount > 0 && sent === 0) throw new Error('FCM_TEMPORARY_FAILURE');
    return { sent, invalidTokenIds, messageIds, failedCount };
  }
}
