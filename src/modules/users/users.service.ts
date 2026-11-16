import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { FieldCryptoService } from '../../security/field-crypto.service';
import { AccountStorageCleanupService } from '../../security/account-storage-cleanup.service';
import { generateUuidV7 } from '../../common/uuid-v7';
import type { PatchMeDto } from './dto/patch-me.dto';
import type { RegisterDeviceDto } from './dto/register-device.dto';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: FieldCryptoService,
    private readonly storageCleanup: AccountStorageCleanupService,
  ) {}

  async getMe(userId: string): Promise<Record<string, unknown>> {
    const user = await this.prisma.user.findFirst({ where: { id: userId, status: 'active', deletedAt: null } });
    if (!user) throw new NotFoundException({
      code: 'USER_NOT_FOUND',
      message: 'No se encontró una cuenta activa.',
      details: {},
    });
    const phone = user.phoneCiphertext && user.phoneNonce && user.phoneTag && user.phoneEncryptedDek && user.phoneKeyVersion
      ? await this.crypto.decrypt({
          ciphertext: Buffer.from(user.phoneCiphertext),
          nonce: Buffer.from(user.phoneNonce),
          tag: Buffer.from(user.phoneTag),
          encryptedDek: Buffer.from(user.phoneEncryptedDek),
          keyVersion: user.phoneKeyVersion,
        }, 'users.phone')
      : null;
    const email = user.emailCiphertext && user.emailNonce && user.emailTag && user.emailEncryptedDek && user.emailKeyVersion
      ? await this.crypto.decrypt({
          ciphertext: Buffer.from(user.emailCiphertext),
          nonce: Buffer.from(user.emailNonce),
          tag: Buffer.from(user.emailTag),
          encryptedDek: Buffer.from(user.emailEncryptedDek),
          keyVersion: user.emailKeyVersion,
        }, 'users.email')
      : null;
    return {
      id: user.id,
      phone,
      display_name: user.displayName,
      email,
      role: user.role,
      status: user.status,
      phone_verified_at: user.phoneVerifiedAt,
      created_at: user.createdAt,
      updated_at: user.updatedAt,
    };
  }

  async patchMe(userId: string, dto: PatchMeDto): Promise<Record<string, unknown>> {
    const data: Prisma.UserUpdateManyMutationInput = {};
    if (dto.display_name === undefined && dto.email === undefined) {
      throw new BadRequestException({
        code: 'EMPTY_PROFILE_UPDATE',
        message: 'Debes indicar al menos un campo para actualizar.',
        details: {},
      });
    }
    if (dto.display_name !== undefined) data.displayName = dto.display_name.trim();
    if (dto.email !== undefined) {
      const normalizedEmail = dto.email.trim().toLowerCase();
      const encrypted = await this.crypto.encrypt(normalizedEmail, 'users.email');
      const index = await this.crypto.blindIndex(normalizedEmail, 'users.email');
      data.emailCiphertext = encrypted.ciphertext;
      data.emailNonce = encrypted.nonce;
      data.emailTag = encrypted.tag;
      data.emailEncryptedDek = encrypted.encryptedDek;
      data.emailKeyVersion = encrypted.keyVersion;
      data.emailHmac = index.digest;
      data.emailHmacKeyVersion = index.keyVersion;
    }
    data.updatedAt = new Date();
    try {
      // Condición de estado para evitar que un PATCH concurrente vuelva a escribir
      // datos personales después de que DELETE /me haya iniciado deletion_pending.
      const updated = await this.prisma.user.updateMany({
        where: { id: userId, status: 'active', deletedAt: null },
        data,
      });
      if (updated.count !== 1) throw new NotFoundException({
        code: 'USER_NOT_FOUND',
        message: 'No se encontró una cuenta activa para actualizar.',
        details: {},
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({
          code: 'EMAIL_ALREADY_IN_USE',
          message: 'Ese correo ya está asociado a otra cuenta.',
          details: {},
        });
      }
      throw error;
    }
    return this.getMe(userId);
  }

  async registerDevice(user: AuthenticatedUser, dto: RegisterDeviceDto): Promise<Record<string, unknown>> {
    if (dto.device_id !== user.device_id) throw new ForbiddenException({
      code: 'DEVICE_MISMATCH',
      message: 'El dispositivo del registro debe coincidir con el dispositivo de la sesión.',
      details: {},
    });
    const tokenIndex = await this.crypto.blindIndex(dto.fcm_token, 'device_tokens.fcm_token');
    const now = new Date();

    const registration = await this.prisma.$transaction(async (tx) => {
      const device = await tx.syncDevice.findFirst({
        where: { id: dto.device_id, userId: user.id, revokedAt: null, deletedAt: null },
      });
      if (!device) throw new NotFoundException({
        code: 'DEVICE_NOT_FOUND',
        message: 'No se encontró un dispositivo activo de esta cuenta.',
        details: {},
      });
      if (device.platform !== dto.platform) throw new ConflictException({
        code: 'DEVICE_PLATFORM_MISMATCH',
        message: 'La plataforma no coincide con la registrada para este dispositivo.',
        details: {},
      });
      await tx.syncDevice.update({
        where: { id: device.id },
        data: {
          deviceLabel: dto.device_label ?? device.deviceLabel,
          clientVersion: dto.app_version ?? device.clientVersion,
          lastSeenAt: now,
          updatedAt: now,
        },
      });

      const existingToken = await tx.deviceToken.findFirst({ where: { tokenHash: tokenIndex.digest } });
      if (existingToken && existingToken.userId !== user.id) throw new ConflictException({
        code: 'FCM_TOKEN_ALREADY_REGISTERED',
        message: 'El token de notificaciones ya está asociado a otra cuenta.',
        details: {},
      });

      await tx.deviceToken.updateMany({
        where: { userId: user.id, syncDeviceId: dto.device_id, status: 'active', ...(existingToken ? { id: { not: existingToken.id } } : {}) },
        data: {
          status: 'revoked', tokenCiphertext: null, tokenNonce: null, tokenTag: null,
          tokenEncryptedDek: null, tokenKeyVersion: null, tokenAadVersion: null, tokenHash: null,
          tokenHmacKeyVersion: null, revokedAt: now, updatedAt: now,
        },
      });

      const tokenRecordId = existingToken?.id ?? generateUuidV7();
      const encryptedToken = await this.crypto.encrypt(dto.fcm_token, 'device_tokens.fcm_token', { userId: user.id, recordId: tokenRecordId });
      if (existingToken) {
        return tx.deviceToken.update({
          where: { id: existingToken.id },
          data: {
            syncDeviceId: dto.device_id,
            platform: dto.platform,
            tokenCiphertext: encryptedToken.ciphertext,
            tokenNonce: encryptedToken.nonce,
            tokenTag: encryptedToken.tag,
            tokenEncryptedDek: encryptedToken.encryptedDek,
            tokenKeyVersion: encryptedToken.keyVersion,
            tokenAadVersion: encryptedToken.aadVersion ?? 2,
            tokenHash: tokenIndex.digest,
            tokenHmacKeyVersion: tokenIndex.keyVersion,
            status: 'active',
            revokedAt: null,
            updatedAt: now,
            lastSeenAt: now,
          },
        });
      }
      return tx.deviceToken.create({
        data: {
          id: tokenRecordId,
          userId: user.id,
          syncDeviceId: dto.device_id,
          platform: dto.platform,
          tokenCiphertext: encryptedToken.ciphertext,
          tokenNonce: encryptedToken.nonce,
          tokenTag: encryptedToken.tag,
          tokenEncryptedDek: encryptedToken.encryptedDek,
          tokenKeyVersion: encryptedToken.keyVersion,
          tokenAadVersion: encryptedToken.aadVersion ?? 2,
          tokenHash: tokenIndex.digest,
          tokenHmacKeyVersion: tokenIndex.keyVersion,
          status: 'active',
          lastSeenAt: now,
        },
      });
    });

    return {
      device_id: dto.device_id,
      platform: registration.platform,
      registered_at: registration.createdAt,
      status: registration.status,
    };
  }

  async exportMe(userId: string): Promise<Record<string, unknown>> {
    const [profile, consents, devices, emergencyContacts] = await Promise.all([
      this.getMe(userId),
      this.prisma.consentLog.findMany({
        where: { userId },
        orderBy: { receivedAt: 'asc' },
        select: {
          id: true,
          consentType: true,
          policyVersion: true,
          accepted: true,
          clientCapturedAt: true,
          receivedAt: true,
          source: true,
          appVersion: true,
          ipCiphertext: true,
          ipNonce: true,
          ipTag: true,
          ipEncryptedDek: true,
          ipKeyVersion: true,
          userAgentCiphertext: true,
          userAgentNonce: true,
          userAgentTag: true,
          userAgentEncryptedDek: true,
          userAgentKeyVersion: true,
        },
      }),
      this.prisma.syncDevice.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          platform: true,
          deviceLabel: true,
          clientVersion: true,
          lastSeenAt: true,
          revokedAt: true,
          createdAt: true,
        },
      }),
      this.prisma.emergencyContact.findMany({
        where: { userId, deletedAt: null }, orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, relationshipLabel: true, isPrimary: true, phoneCiphertext: true, phoneNonce: true,
          phoneTag: true, phoneEncryptedDek: true, phoneKeyVersion: true, phoneAadVersion: true, createdAt: true },
      }),
    ]);
    const exportedConsents = await Promise.all(consents.map(async (consent) => ({
      id: consent.id,
      consent_type: consent.consentType,
      policy_version: consent.policyVersion,
      accepted: consent.accepted,
      client_captured_at: consent.clientCapturedAt,
      received_at: consent.receivedAt,
      source: consent.source,
      app_version: consent.appVersion,
      ip_address: consent.ipCiphertext && consent.ipNonce && consent.ipTag && consent.ipEncryptedDek && consent.ipKeyVersion
        ? await this.crypto.decrypt({
            ciphertext: Buffer.from(consent.ipCiphertext), nonce: Buffer.from(consent.ipNonce),
            tag: Buffer.from(consent.ipTag), encryptedDek: Buffer.from(consent.ipEncryptedDek),
            keyVersion: consent.ipKeyVersion,
          }, 'consent_logs.ip_address')
        : null,
      user_agent: consent.userAgentCiphertext && consent.userAgentNonce && consent.userAgentTag && consent.userAgentEncryptedDek && consent.userAgentKeyVersion
        ? await this.crypto.decrypt({
            ciphertext: Buffer.from(consent.userAgentCiphertext), nonce: Buffer.from(consent.userAgentNonce),
            tag: Buffer.from(consent.userAgentTag), encryptedDek: Buffer.from(consent.userAgentEncryptedDek),
            keyVersion: consent.userAgentKeyVersion,
          }, 'consent_logs.user_agent')
        : null,
    })));
    const exportedEmergencyContacts = await Promise.all(emergencyContacts.map(async (contact) => ({
      id: contact.id, name: contact.name, relationship_label: contact.relationshipLabel, is_primary: contact.isPrimary,
      phone_e164: contact.phoneCiphertext && contact.phoneNonce && contact.phoneTag && contact.phoneEncryptedDek && contact.phoneKeyVersion
        ? await this.crypto.decrypt({
            ciphertext: Buffer.from(contact.phoneCiphertext), nonce: Buffer.from(contact.phoneNonce),
            tag: Buffer.from(contact.phoneTag), encryptedDek: Buffer.from(contact.phoneEncryptedDek),
            keyVersion: contact.phoneKeyVersion, aadVersion: contact.phoneAadVersion ?? 1,
          }, 'emergency_contacts.phone', (contact.phoneAadVersion ?? 1) >= 2 ? { userId, recordId: contact.id } : undefined)
        : null,
      created_at: contact.createdAt,
    })));
    return {
      format_version: '1.0',
      exported_at: new Date().toISOString(),
      included_domains: ['identity', 'consent', 'devices', 'emergency_contacts'],
      data: { profile, consents: exportedConsents, devices, emergency_contacts: exportedEmergencyContacts },
    };
  }

  async deleteMe(userId: string): Promise<Record<string, unknown>> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw this.localPurgeRequired();
    if (user.status === 'deleted') throw this.localPurgeRequired();

    if (user.status !== 'deletion_pending') {
      const pendingAt = new Date();
      // Bloquea nuevas sesiones y detiene notificaciones antes de llamar a S3.
      // SyncDevice se revoca al finalizar para permitir reintentar DELETE /me si S3 falla.
      await this.prisma.$transaction(async (tx) => {
        await tx.reminder.updateMany({ where: { userId, status: { in: ['scheduled', 'processing'] }, deletedAt: null }, data: { status: 'cancelled', cancelledAt: pendingAt } });
        await tx.notificationPreference.updateMany({ where: { userId, deletedAt: null }, data: { deletedAt: pendingAt } });
        await tx.user.update({
          where: { id: userId },
          data: { status: 'deletion_pending', updatedAt: pendingAt },
        });
        await tx.refreshToken.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: pendingAt },
        });
        await tx.deviceToken.updateMany({
          where: { userId, status: 'active' },
          data: {
            status: 'revoked',
            tokenCiphertext: null,
            tokenNonce: null,
            tokenTag: null,
            tokenEncryptedDek: null,
            tokenKeyVersion: null,
            tokenAadVersion: null,
            tokenHash: null,
            tokenHmacKeyVersion: null,
            revokedAt: pendingAt,
            updatedAt: pendingAt,
          },
        });
      });
    }

    // Primero se limpian los prefijos privados de la cuenta. Si S3 falla, se conserva
    // deletion_pending y el usuario puede repetir DELETE /me sin reactivar la cuenta.
    const filesCleanup = await this.storageCleanup.deleteUserObjects(userId);
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
      await tx.deviceToken.updateMany({
        where: { userId },
        data: {
          status: 'revoked',
          tokenCiphertext: null,
          tokenNonce: null,
          tokenTag: null,
          tokenEncryptedDek: null,
          tokenKeyVersion: null,
          tokenAadVersion: null,
          tokenHash: null,
          tokenHmacKeyVersion: null,
          revokedAt: now,
          updatedAt: now,
        },
      });
      await tx.emergencyContact.updateMany({
        where: { userId, deletedAt: null },
        data: {
          deletedAt: now, phoneCiphertext: null, phoneNonce: null, phoneTag: null,
          phoneEncryptedDek: null, phoneKeyVersion: null, phoneAadVersion: null,
          phoneHmac: null, phoneHmacKeyVersion: null,
        },
      });
      await tx.syncDevice.updateMany({
        where: { userId },
        data: {
          revokedAt: now,
          deletedAt: now,
          deviceLabel: null,
          clientVersion: null,
          lastSeenAt: null,
          lastCursor: null,
          updatedAt: now,
        },
      });
      // ConsentLog es append-only salvo esta operación de anonimización autorizada.
      await tx.consentLog.updateMany({
        where: { userId, OR: [{ ipCiphertext: { not: null } }, { userAgentCiphertext: { not: null } }] },
        data: {
          ipCiphertext: null, ipNonce: null, ipTag: null, ipEncryptedDek: null, ipKeyVersion: null,
          userAgentCiphertext: null, userAgentNonce: null, userAgentTag: null,
          userAgentEncryptedDek: null, userAgentKeyVersion: null,
        },
      });
      await tx.user.update({
        where: { id: userId },
        data: {
          status: 'deleted',
          deletedAt: now,
          updatedAt: now,
          phoneCiphertext: null,
          phoneNonce: null,
          phoneTag: null,
          phoneEncryptedDek: null,
          phoneKeyVersion: null,
          phoneHmac: null,
          phoneHmacKeyVersion: null,
          emailCiphertext: null,
          emailNonce: null,
          emailTag: null,
          emailEncryptedDek: null,
          emailKeyVersion: null,
          emailHmac: null,
          emailHmacKeyVersion: null,
          displayName: 'Cuenta eliminada',
          phoneVerifiedAt: null,
          lastLoginAt: null,
        },
      });
    });

    return {
      status: 'deleted',
      files_cleanup: filesCleanup,
      local_cleanup_code: 'LOCAL_DATA_PURGE_REQUIRED',
      message: 'La cuenta fue eliminada y las sesiones y dispositivos quedaron invalidados. Borra todos los datos privados locales.',
    };
  }

  private localPurgeRequired(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'LOCAL_DATA_PURGE_REQUIRED',
      message: 'La cuenta fue eliminada. Borra todos los datos privados almacenados en este dispositivo.',
      details: { purge_local_data: true },
    });
  }
}
