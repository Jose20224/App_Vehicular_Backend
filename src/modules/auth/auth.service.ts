import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  TooManyRequestsException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client';
import { AppConfigService } from '../../config/config.module';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { FieldCryptoService } from '../../security/field-crypto.service';
import { generateUuidV7 } from '../../common/uuid-v7';
import { OTP_PROVIDER, type OtpProvider } from './providers/otp-provider.interface';
import { Inject } from '@nestjs/common';
import type { Request } from 'express';
import type { VerifyOtpDto } from './dto/verify-otp.dto';
import type { RequestOtpDto } from './dto/request-otp.dto';
import type { RefreshTokenDto } from './dto/refresh-token.dto';

const OTP_REQUEST_COUNTER_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return current
`;

interface OtpMetadata {
  channel: 'sms' | 'whatsapp';
  requested_at: string;
}

interface RefreshPayload {
  sub: string;
  token_use: 'refresh';
  family_id: string;
  device_id: string;
  exp?: number;
}

interface LockedRefreshToken {
  id: string;
  user_id: string;
  family_id: string;
  device_id: string;
  expires_at: Date;
  revoked_at: Date | null;
  replaced_by_id: string | null;
}

interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_expires_in: number;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly issuer = 'vehicular-api';
  private readonly audience = 'vehicular-mobile';

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
    private readonly crypto: FieldCryptoService,
    @Inject(OTP_PROVIDER) private readonly otpProvider: OtpProvider,
  ) {}

  async requestOtp(dto: RequestOtpDto): Promise<Record<string, unknown>> {
    const phone = dto.phone.trim();
    // La huella HMAC evita que un volcado de Redis permita enumerar números +505.
    const phoneKey = (await this.crypto.blindIndex(phone, 'auth.otp.rate_limit')).digest.toString('hex');
    const lockKey = `auth:otp:lock:v1:${phoneKey}`;
    const requestKey = `auth:otp:requests:v1:${phoneKey}`;

    if (await this.redis.client.exists(lockKey)) throw this.otpLocked();

    const requests = Number(await this.redis.client.eval(
      OTP_REQUEST_COUNTER_SCRIPT,
      1,
      requestKey,
      '3600',
    ));
    if (requests > this.config.value.otpMaxRequestsPerHour) {
      const retryAfter = Math.max(await this.redis.client.ttl(requestKey), 1);
      throw new TooManyRequestsException({
        code: 'OTP_REQUEST_LIMIT_EXCEEDED',
        message: 'Alcanzaste el límite de solicitudes de códigos para este número. Inténtalo más tarde.',
        details: { retry_after_seconds: retryAfter },
      });
    }

    try {
      await this.otpProvider.request(phone, dto.channel);
      const metadata: OtpMetadata = { channel: dto.channel, requested_at: new Date().toISOString() };
      await this.redis.client.set(
        `auth:otp:challenge:v1:${phoneKey}`,
        JSON.stringify(metadata),
        'EX',
        this.config.value.otpCodeTtlSeconds,
      );
      // Los reenvíos no reinician el contador: evita obtener 5 intentos nuevos
      // cada vez que se solicita otro código. La ventana se mantiene por una hora.
      await this.redis.client.set(
        `auth:otp:attempts:v1:${phoneKey}`,
        '0',
        'EX',
        3600,
        'NX',
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException({
        code: 'OTP_REQUEST_UNAVAILABLE',
        message: 'No fue posible iniciar la verificación. Inténtalo nuevamente.',
        details: {},
      });
    }

    return {
      message: `Si el número puede recibir mensajes, se enviará un código por ${dto.channel}.`,
      channel: dto.channel,
      expires_in_seconds: this.config.value.otpCodeTtlSeconds,
      ...(this.config.value.otpMode === 'mock'
        ? { debug_code: this.config.value.otpMockCode }
        : {}),
    };
  }

  async verifyOtp(dto: VerifyOtpDto, request: Request): Promise<Record<string, unknown>> {
    const phone = dto.phone.trim();
    // La misma huella pseudónima se usa en lock/challenge/attempts; el teléfono
    // permanece fuera de las claves Redis incluso en los entornos compartidos.
    const phoneKey = (await this.crypto.blindIndex(phone, 'auth.otp.rate_limit')).digest.toString('hex');
    const lockKey = `auth:otp:lock:v1:${phoneKey}`;
    const challengeKey = `auth:otp:challenge:v1:${phoneKey}`;
    const attemptsKey = `auth:otp:attempts:v1:${phoneKey}`;

    if (await this.redis.client.exists(lockKey)) throw this.otpLocked();
    const rawMetadata = await this.redis.client.get(challengeKey);
    if (!rawMetadata) throw new UnauthorizedException({
      code: 'OTP_EXPIRED',
      message: 'El código venció o no existe una solicitud activa. Solicita uno nuevo.',
      details: {},
    });
    const metadata = JSON.parse(rawMetadata) as OtpMetadata;
    const requestedAt = new Date(metadata.requested_at).getTime();
    if (!Number.isFinite(requestedAt) || Date.now() - requestedAt > this.config.value.otpCodeTtlSeconds * 1000) {
      await this.clearOtpChallengeKey(phoneKey);
      throw new UnauthorizedException({
        code: 'OTP_EXPIRED',
        message: 'El código venció. Solicita uno nuevo.',
        details: {},
      });
    }

    const phoneIndex = await this.crypto.blindIndex(phone, 'users.phone');
    const existing = await this.prisma.user.findFirst({
      where: { phoneHmac: phoneIndex.digest, deletedAt: null },
      select: { id: true, status: true },
    });
    const currentConsent = existing
      ? await this.prisma.consentLog.findFirst({
          where: {
            userId: existing.id,
            consentType: 'privacy_policy',
            policyVersion: this.config.value.consentPolicyVersion,
            accepted: true,
          },
          select: { id: true },
        })
      : null;
    if ((!existing || !currentConsent) && (
      !dto.consent?.accepted || dto.consent.policy_version !== this.config.value.consentPolicyVersion
    )) {
      throw new ForbiddenException({
        code: dto.consent?.policy_version && dto.consent.policy_version !== this.config.value.consentPolicyVersion
          ? 'CONSENT_VERSION_MISMATCH'
          : 'CONSENT_REQUIRED',
        message: 'Debes aceptar la versión vigente de la política de privacidad antes de crear o activar la cuenta.',
        details: { required_policy_version: this.config.value.consentPolicyVersion },
      });
    }

    const approved = await this.otpProvider.verify(phone, dto.code);
    if (!approved) {
      const attempts = await this.redis.client.incr(attemptsKey);
      if (attempts === 1) await this.redis.client.expire(attemptsKey, this.config.value.otpCodeTtlSeconds);
      const remaining = Math.max(this.config.value.otpMaxFailedAttempts - attempts, 0);
      if (attempts >= this.config.value.otpMaxFailedAttempts) {
        await this.redis.client.set(lockKey, '1', 'EX', this.config.value.otpLockMinutes * 60);
        await this.clearOtpKeysBestEffort(phoneKey);
        throw this.otpLocked();
      }
      throw new UnauthorizedException({
        code: 'OTP_INVALID',
        message: 'El código ingresado no es correcto.',
        details: { attempts_remaining: remaining },
      });
    }

    const encryptedPhone = existing ? null : await this.crypto.encrypt(phone, 'users.phone');
    const shouldRecordConsent = !existing || !currentConsent;
    const now = new Date();
    const userAgent = shouldRecordConsent
      ? String(request.headers['user-agent'] ?? '').slice(0, 512) || null
      : null;
    const ipAddress = shouldRecordConsent
      ? (request.ip ?? request.socket.remoteAddress ?? null)?.slice(0, 64) ?? null
      : null;
    const encryptedIp = ipAddress ? await this.crypto.encrypt(ipAddress, 'consent_logs.ip_address') : null;
    const encryptedUserAgent = userAgent ? await this.crypto.encrypt(userAgent, 'consent_logs.user_agent') : null;

    const result = await this.prisma.$transaction(async (tx) => {
      let user = await tx.user.findFirst({ where: { phoneHmac: phoneIndex.digest, deletedAt: null } });
      let isNewUser = false;
      if (!user) {
        if (!encryptedPhone) throw new Error('No se preparó el cifrado del teléfono.');
        try {
          user = await tx.user.create({
            data: {
              id: generateUuidV7(),
              phoneCiphertext: encryptedPhone.ciphertext,
              phoneNonce: encryptedPhone.nonce,
              phoneTag: encryptedPhone.tag,
              phoneEncryptedDek: encryptedPhone.encryptedDek,
              phoneKeyVersion: encryptedPhone.keyVersion,
              phoneHmac: phoneIndex.digest,
              phoneHmacKeyVersion: phoneIndex.keyVersion,
              displayName: dto.display_name?.trim() || 'Usuario',
              role: 'user',
              status: 'active',
              phoneVerifiedAt: now,
              lastLoginAt: now,
            },
          });
          isNewUser = true;
        } catch (error) {
          if (this.isUniqueViolation(error)) throw new ConflictException({
            code: 'PHONE_ALREADY_REGISTERED',
            message: 'El número ya está asociado a una cuenta. Solicita un nuevo código e inténtalo otra vez.',
            details: {},
          });
          throw error;
        }
      } else {
        if (user.status === 'deletion_pending' || user.status === 'deleted') {
          throw new ConflictException({
            code: 'ACCOUNT_DELETION_PENDING',
            message: 'La cuenta está en proceso de eliminación y no puede iniciar sesión.',
            details: {},
          });
        }
        if (user.status === 'suspended') throw new ForbiddenException({
          code: 'ACCOUNT_SUSPENDED',
          message: 'La cuenta está suspendida. Contacta con soporte.',
          details: {},
        });
        user = await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: now, phoneVerifiedAt: now, updatedAt: now } });
      }

      const existingDevice = await tx.syncDevice.findUnique({ where: { id: dto.device_id } });
      if (existingDevice && existingDevice.userId !== user.id) {
        throw new ConflictException({
          code: 'DEVICE_ID_IN_USE',
          message: 'El identificador del dispositivo ya pertenece a otra cuenta.',
          details: {},
        });
      }
      if (existingDevice) {
        await tx.syncDevice.update({
          where: { id: dto.device_id },
          data: {
            platform: dto.platform,
            deviceLabel: dto.device_label,
            clientVersion: dto.app_version,
            lastSeenAt: now,
            revokedAt: null,
            deletedAt: null,
            updatedAt: now,
          },
        });
      } else {
        await tx.syncDevice.create({
          data: {
            id: dto.device_id,
            userId: user.id,
            platform: dto.platform,
            deviceLabel: dto.device_label,
            clientVersion: dto.app_version,
            lastSeenAt: now,
          },
        });
      }

      if (!currentConsent || isNewUser) {
        await tx.consentLog.create({
          data: {
            id: generateUuidV7(),
            userId: user.id,
            consentType: 'privacy_policy',
            policyVersion: this.config.value.consentPolicyVersion,
            accepted: true,
            // El servidor no afirma conocer el instante del consentimiento en el dispositivo.
            // receivedAt registra el momento confiable de recepción.
            clientCapturedAt: null,
            receivedAt: now,
            source: 'mobile',
            appVersion: dto.app_version,
            ipCiphertext: encryptedIp?.ciphertext,
            ipNonce: encryptedIp?.nonce,
            ipTag: encryptedIp?.tag,
            ipEncryptedDek: encryptedIp?.encryptedDek,
            ipKeyVersion: encryptedIp?.keyVersion,
            userAgentCiphertext: encryptedUserAgent?.ciphertext,
            userAgentNonce: encryptedUserAgent?.nonce,
            userAgentTag: encryptedUserAgent?.tag,
            userAgentEncryptedDek: encryptedUserAgent?.encryptedDek,
            userAgentKeyVersion: encryptedUserAgent?.keyVersion,
          },
        });
      }

      const tokens = await this.createTokenPair(tx, user.id, user.role, dto.device_id);
      return {
        tokens,
        is_new_user: isNewUser,
        user: {
          id: user.id,
          phone,
          display_name: user.displayName,
          role: user.role,
          created_at: user.createdAt,
        },
      };
    });

    // La sesión ya quedó confirmada en PostgreSQL. Un fallo transitorio al
    // limpiar Redis no debe convertir un alta exitosa en una respuesta fallida.
    await this.clearOtpKeysBestEffort(phoneKey);
    return result;
  }

  async refresh(dto: RefreshTokenDto): Promise<TokenPair> {
    let payload: RefreshPayload;
    try {
      // Verifica la firma aunque el JWT haya expirado, para poder reconocer una
      // cuenta/dispositivo revocado y emitir LOCAL_DATA_PURGE_REQUIRED cuando
      // el cliente vuelva a conectarse después de una eliminación remota.
      payload = await this.jwt.verifyAsync<RefreshPayload>(dto.refresh_token, {
        secret: this.config.value.jwtRefreshSecret,
        algorithms: ['HS256'],
        issuer: this.issuer,
        audience: this.audience,
        ignoreExpiration: true,
      });
    } catch {
      throw this.authRequired();
    }
    if (payload.token_use !== 'refresh' || !payload.sub || !payload.family_id || !payload.device_id || !Number.isFinite(payload.exp)) {
      throw this.authRequired();
    }
    const jwtExpired = (payload.exp as number) <= Math.floor(Date.now() / 1000);

    const hash = createHash('sha256').update(dto.refresh_token).digest();
    const outcome = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<LockedRefreshToken[]>(Prisma.sql`
        SELECT id, user_id, family_id, device_id, expires_at, revoked_at, replaced_by_id
        FROM public.refresh_tokens
        WHERE token_hash = ${hash}
        FOR UPDATE
      `);
      const stored = rows[0];
      if (!stored) {
        const user = await tx.user.findUnique({ where: { id: payload.sub }, select: { status: true } });
        return user?.status === 'deleted' || user?.status === 'deletion_pending'
          ? { kind: 'purge' as const }
          : { kind: 'invalid' as const };
      }

      if (stored.revoked_at || stored.replaced_by_id) {
        const now = new Date();
        await tx.refreshToken.updateMany({ where: { familyId: stored.family_id }, data: { revokedAt: now } });
        await tx.deviceToken.updateMany({
          where: { syncDeviceId: stored.device_id, userId: stored.user_id, status: 'active' },
          data: {
            status: 'revoked', tokenCiphertext: null, tokenNonce: null, tokenTag: null,
            tokenEncryptedDek: null, tokenKeyVersion: null, tokenHash: null,
            tokenHmacKeyVersion: null, revokedAt: now, updatedAt: now,
          },
        });
        await tx.syncDevice.updateMany({
          where: { id: stored.device_id, userId: stored.user_id, revokedAt: null },
          data: { revokedAt: now, updatedAt: now },
        });
        return { kind: 'reuse' as const };
      }
      if (stored.user_id !== payload.sub || stored.family_id !== payload.family_id || stored.device_id !== payload.device_id) {
        return { kind: 'invalid' as const };
      }

      const user = await tx.user.findUnique({ where: { id: stored.user_id } });
      if (!user || user.status === 'deleted' || user.status === 'deletion_pending') return { kind: 'purge' as const };
      const device = await tx.syncDevice.findFirst({
        where: { id: stored.device_id, userId: user.id },
        select: { revokedAt: true, deletedAt: true },
      });
      if (!device || device.revokedAt || device.deletedAt) return { kind: 'purge' as const };
      if (new Date(stored.expires_at).getTime() <= Date.now() || jwtExpired) return { kind: 'invalid' as const };
      if (user.status !== 'active') return { kind: 'suspended' as const };

      const tokens = await this.createTokenPair(tx, user.id, user.role, device.id, stored.family_id);
      const replacement = await tx.refreshToken.findFirst({
        where: { tokenHash: createHash('sha256').update(tokens.refresh_token).digest() },
        select: { id: true },
      });
      await tx.refreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: new Date(), replacedById: replacement?.id, lastUsedAt: new Date() },
      });
      return { kind: 'rotated' as const, tokens };
    });

    if (outcome.kind === 'purge' || outcome.kind === 'reuse') throw this.localPurgeRequired();
    if (outcome.kind === 'suspended') throw new ForbiddenException({
      code: 'ACCOUNT_SUSPENDED',
      message: 'La cuenta está suspendida. Contacta con soporte.',
      details: {},
    });
    if (outcome.kind !== 'rotated') throw this.authRequired();
    return outcome.tokens;
  }

  async logout(dto: RefreshTokenDto): Promise<void> {
    const hash = createHash('sha256').update(dto.refresh_token).digest();
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<LockedRefreshToken[]>(Prisma.sql`
        SELECT id, user_id, family_id, device_id, expires_at, revoked_at, replaced_by_id
        FROM public.refresh_tokens WHERE token_hash = ${hash} FOR UPDATE
      `);
      const stored = rows[0];
      if (!stored) return;
      const now = new Date();
      await tx.refreshToken.updateMany({ where: { familyId: stored.family_id }, data: { revokedAt: now } });
      await tx.deviceToken.updateMany({
        where: { syncDeviceId: stored.device_id, userId: stored.user_id, status: 'active' },
        data: {
          status: 'revoked', tokenCiphertext: null, tokenNonce: null, tokenTag: null,
          tokenEncryptedDek: null, tokenKeyVersion: null, tokenHash: null,
          tokenHmacKeyVersion: null, revokedAt: now, updatedAt: now,
        },
      });
      await tx.syncDevice.updateMany({
        where: { id: stored.device_id, userId: stored.user_id, revokedAt: null },
        data: { revokedAt: now, updatedAt: now },
      });
    });
  }

  private async createTokenPair(
    tx: Prisma.TransactionClient,
    userId: string,
    role: string,
    deviceId: string,
    existingFamilyId?: string,
  ): Promise<TokenPair> {
    const now = new Date();
    const familyId = existingFamilyId ?? generateUuidV7();
    const refreshToken = await this.jwt.signAsync({
      sub: userId,
      token_use: 'refresh',
      family_id: familyId,
      device_id: deviceId,
    }, {
      secret: this.config.value.jwtRefreshSecret,
      algorithm: 'HS256',
      expiresIn: this.config.value.jwtRefreshTtlSeconds,
      issuer: this.issuer,
      audience: this.audience,
      jwtid: generateUuidV7(),
    });
    const accessToken = await this.jwt.signAsync({
      sub: userId,
      role,
      token_use: 'access',
      device_id: deviceId,
    }, {
      secret: this.config.value.jwtAccessSecret,
      algorithm: 'HS256',
      expiresIn: this.config.value.jwtAccessTtlSeconds,
      issuer: this.issuer,
      audience: this.audience,
      jwtid: generateUuidV7(),
    });

    await tx.refreshToken.create({
      data: {
        userId,
        tokenHash: createHash('sha256').update(refreshToken).digest(),
        familyId,
        deviceId,
        expiresAt: new Date(now.getTime() + this.config.value.jwtRefreshTtlSeconds * 1000),
      },
    });
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: this.config.value.jwtAccessTtlSeconds,
      refresh_expires_in: this.config.value.jwtRefreshTtlSeconds,
    };
  }

  private async clearOtpChallengeKey(phoneKey: string): Promise<void> {
    await this.redis.client.del(`auth:otp:challenge:v1:${phoneKey}`);
  }

  private async clearOtpKeysBestEffort(phoneKey: string): Promise<void> {
    try {
      await this.redis.client.del(
        `auth:otp:challenge:v1:${phoneKey}`,
        `auth:otp:attempts:v1:${phoneKey}`,
      );
    } catch {
      // Twilio invalida una verificación aprobada; el proveedor mock también es
      // de un solo uso. El TTL del challenge evita que el registro quede vivo
      // indefinidamente si Redis está degradado.
      this.logger.warn('No fue posible limpiar el challenge OTP después de autenticar.');
    }
  }

  private otpLocked(): TooManyRequestsException {
    return new TooManyRequestsException({
      code: 'OTP_TEMPORARILY_BLOCKED',
      message: 'Se bloquearon temporalmente los intentos de verificación. Inténtalo más tarde.',
      details: { lock_minutes: this.config.value.otpLockMinutes },
    });
  }

  private authRequired(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'AUTH_REQUIRED',
      message: 'El token no es válido o venció. Inicia sesión nuevamente.',
      details: {},
    });
  }

  private localPurgeRequired(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'LOCAL_DATA_PURGE_REQUIRED',
      message: 'La sesión o el dispositivo fue revocado. Borra todos los datos privados almacenados en este dispositivo.',
      details: { purge_local_data: true },
    });
  }

  private isUniqueViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }
}
