import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { TooManyRequestsException } from '../../src/common/exceptions/too-many-requests.exception';
import type { Request } from 'express';
import { AuthService } from '../../src/modules/auth/auth.service';
import type { AppConfigService } from '../../src/config/config.module';
import type { PrismaService } from '../../src/database/prisma.service';
import type { RedisService } from '../../src/redis/redis.service';
import type { FieldCryptoService } from '../../src/security/field-crypto.service';
import type { OtpProvider } from '../../src/modules/auth/providers/otp-provider.interface';
import type { JwtService } from '@nestjs/jwt';

const config = {
  value: {
    otpMode: 'mock',
    otpMockCode: '123456',
    otpCodeTtlSeconds: 300,
    otpMaxRequestsPerHour: 5,
    otpMaxFailedAttempts: 5,
    otpLockMinutes: 15,
    consentPolicyVersion: 'privacy-2026-11-v1',
    jwtAccessSecret: 'access-secret-for-unit-test-at-least-32-bytes',
    jwtRefreshSecret: 'refresh-secret-for-unit-test-at-least-32-bytes',
    jwtAccessTtlSeconds: 900,
    jwtRefreshTtlSeconds: 2592000,
  },
} as AppConfigService;

function exceptionBody(error: unknown): Record<string, unknown> {
  if (error instanceof ForbiddenException || error instanceof UnauthorizedException || error instanceof TooManyRequestsException) {
    return error.getResponse() as Record<string, unknown>;
  }
  throw error;
}

function createRedisMock() {
  const client = {
    exists: jest.fn().mockResolvedValue(0),
    get: jest.fn().mockResolvedValue(JSON.stringify({ channel: 'sms', requested_at: new Date().toISOString() })),
    incr: jest.fn().mockResolvedValue(1),
    eval: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    ttl: jest.fn().mockResolvedValue(3600),
  };
  return { client } as unknown as RedisService & { client: typeof client };
}

function createRequest(): Request {
  return {
    headers: { 'user-agent': 'test-agent' },
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as Request;
}

describe('AuthService — reglas B1', () => {
  it('no verifica OTP ni crea sesión cuando falta el consentimiento vigente', async () => {
    const redis = createRedisMock();
    const prisma = {
      user: { findFirst: jest.fn().mockResolvedValue(null) },
      consentLog: { findFirst: jest.fn() },
      $transaction: jest.fn(),
    } as unknown as PrismaService;
    const crypto = {
      blindIndex: jest.fn().mockResolvedValue({ digest: Buffer.alloc(32, 1), keyVersion: 'local-hmac-v1' }),
    } as unknown as FieldCryptoService;
    const otp = { request: jest.fn(), verify: jest.fn() } as unknown as OtpProvider;
    const jwt = {} as JwtService;
    const service = new AuthService(prisma, redis, jwt, config, crypto, otp);

    let thrown: unknown;
    try {
      await service.verifyOtp({
        phone: '+50588881234',
        code: '123456',
        device_id: '018bcfe5-6800-7abc-8def-0123456789ab',
        platform: 'android',
      }, createRequest());
    } catch (error) {
      thrown = error;
    }

    expect(exceptionBody(thrown).code).toBe('CONSENT_REQUIRED');
    expect(otp.verify).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });


  it('crea la identidad, registra consentimiento y emite sesión solo después del OTP aprobado', async () => {
    const redis = createRedisMock();
    const now = new Date();
    const tx = {
      user: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 'user-1', role: 'user', status: 'active', displayName: 'Nueva persona', createdAt: now,
        }),
      },
      syncDevice: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}) },
      consentLog: { create: jest.fn().mockResolvedValue({}) },
      refreshToken: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      user: { findFirst: jest.fn().mockResolvedValue(null) },
      consentLog: { findFirst: jest.fn() },
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as PrismaService;
    const crypto = {
      blindIndex: jest.fn().mockResolvedValue({ digest: Buffer.alloc(32, 1), keyVersion: 'local-hmac-v1' }),
      encrypt: jest.fn().mockResolvedValue({
        ciphertext: Buffer.from('cipher'), nonce: Buffer.alloc(12), tag: Buffer.alloc(16),
        encryptedDek: Buffer.from('wrapped-key'), keyVersion: 'local-v1',
      }),
    } as unknown as FieldCryptoService;
    const otp = { request: jest.fn(), verify: jest.fn().mockResolvedValue(true) } as unknown as OtpProvider;
    const jwt = { signAsync: jest.fn().mockResolvedValueOnce('refresh.jwt.token').mockResolvedValueOnce('access.jwt.token') } as unknown as JwtService;
    const service = new AuthService(prisma, redis, jwt, config, crypto, otp);

    const result = await service.verifyOtp({
      phone: '+50588881234',
      code: '123456',
      device_id: '018bcfe5-6800-7abc-8def-0123456789ab',
      platform: 'android',
      display_name: 'Nueva persona',
      app_version: '1.0.0',
      consent: { policy_version: 'privacy-2026-11-v1', accepted: true },
    }, createRequest());

    expect(tx.user.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ role: 'user' }) }));
    expect(tx.syncDevice.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ id: '018bcfe5-6800-7abc-8def-0123456789ab' }) }));
    expect(tx.consentLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ accepted: true, policyVersion: 'privacy-2026-11-v1', clientCapturedAt: null }) }));
    expect(tx.refreshToken.create).toHaveBeenCalled();
    expect(result).toMatchObject({ is_new_user: true, tokens: { access_token: 'access.jwt.token', refresh_token: 'refresh.jwt.token' } });
  });


  it('aplica el límite horario de solicitudes OTP por número', async () => {
    const redis = createRedisMock();
    redis.client.eval.mockResolvedValue(6);
    redis.client.ttl.mockResolvedValue(1800);
    const otp = { request: jest.fn(), verify: jest.fn() } as unknown as OtpProvider;
    const crypto = { blindIndex: jest.fn().mockResolvedValue({ digest: Buffer.alloc(32, 4), keyVersion: 'local-hmac-v1' }) } as unknown as FieldCryptoService;
    const service = new AuthService({} as PrismaService, redis, {} as JwtService, config, crypto, otp);

    await expect(service.requestOtp({ phone: '+50588881234', channel: 'sms' })).rejects.toBeInstanceOf(TooManyRequestsException);
    expect(otp.request).not.toHaveBeenCalled();
  });

  it('rechaza un challenge OTP vencido antes de consultar al proveedor', async () => {
    const redis = createRedisMock();
    redis.client.get.mockResolvedValue(JSON.stringify({
      channel: 'sms', requested_at: new Date(Date.now() - 600_000).toISOString(),
    }));
    const otp = { request: jest.fn(), verify: jest.fn() } as unknown as OtpProvider;
    const crypto = { blindIndex: jest.fn().mockResolvedValue({ digest: Buffer.alloc(32, 4), keyVersion: 'local-hmac-v1' }) } as unknown as FieldCryptoService;
    const service = new AuthService({} as PrismaService, redis, {} as JwtService, config, crypto, otp);

    await expect(service.verifyOtp({
      phone: '+50588881234', code: '123456',
      device_id: '018bcfe5-6800-7abc-8def-0123456789ab', platform: 'android',
      consent: { policy_version: 'privacy-2026-11-v1', accepted: true },
    }, createRequest())).rejects.toBeInstanceOf(UnauthorizedException);
    expect(otp.verify).not.toHaveBeenCalled();
  });

  it('bloquea temporalmente al quinto intento fallido', async () => {
    const redis = createRedisMock();
    let attempts = 0;
    redis.client.incr.mockImplementation(async () => ++attempts);
    const prisma = {
      user: { findFirst: jest.fn().mockResolvedValue({ id: 'user-1', status: 'active' }) },
      consentLog: { findFirst: jest.fn().mockResolvedValue({ id: 'consent-1' }) },
    } as unknown as PrismaService;
    const crypto = {
      blindIndex: jest.fn().mockResolvedValue({ digest: Buffer.alloc(32, 1), keyVersion: 'local-hmac-v1' }),
    } as unknown as FieldCryptoService;
    const otp = { request: jest.fn(), verify: jest.fn().mockResolvedValue(false) } as unknown as OtpProvider;
    const service = new AuthService(prisma, redis, {} as JwtService, config, crypto, otp);
    const dto = {
      phone: '+50588881234',
      code: '000000',
      device_id: '018bcfe5-6800-7abc-8def-0123456789ab',
      platform: 'android' as const,
      consent: { policy_version: 'privacy-2026-11-v1', accepted: true },
    };

    for (let index = 1; index <= 4; index += 1) {
      await expect(service.verifyOtp(dto, createRequest())).rejects.toBeInstanceOf(UnauthorizedException);
    }
    let fifthError: unknown;
    try {
      await service.verifyOtp(dto, createRequest());
    } catch (error) {
      fifthError = error;
    }

    expect(exceptionBody(fifthError).code).toBe('OTP_TEMPORARILY_BLOCKED');
    expect(redis.client.set).toHaveBeenCalledWith(
      expect.stringContaining('auth:otp:lock:v1:'), '1', 'EX', 900,
    );
    expect(attempts).toBe(5);
  });

  it('un reenvío de OTP no reinicia el contador de intentos de la ventana', async () => {
    const redis = createRedisMock();
    const service = new AuthService(
      {} as PrismaService,
      redis,
      {} as JwtService,
      config,
      { blindIndex: jest.fn().mockResolvedValue({ digest: Buffer.alloc(32, 4), keyVersion: 'local-hmac-v1' }) } as unknown as FieldCryptoService,
      { request: jest.fn().mockResolvedValue(undefined), verify: jest.fn() } as OtpProvider,
    );

    await service.requestOtp({ phone: '+50588881234', channel: 'sms' });

    expect(redis.client.set).toHaveBeenCalledWith(
      expect.stringContaining('auth:otp:attempts:v1:'), '0', 'EX', 3600, 'NX',
    );
    expect(redis.client.eval).toHaveBeenCalledWith(expect.stringContaining("redis.call('EXPIRE'"), 1, expect.stringContaining('auth:otp:requests:v1:'), '3600');
  });

  it('la reutilización de un refresh token revoca su familia y el dispositivo', async () => {
    const redis = createRedisMock();
    const refreshToken = 'refresh.jwt.token-with-enough-length-for-test';
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{
        id: 'refresh-row',
        user_id: 'user-1',
        family_id: 'family-1',
        device_id: '018bcfe5-6800-7abc-8def-0123456789ab',
        expires_at: new Date(Date.now() + 60_000),
        revoked_at: new Date(),
        replaced_by_id: 'replacement-row',
      }]),
      refreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
      syncDevice: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      deviceToken: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as PrismaService;
    const jwt = {
      verifyAsync: jest.fn().mockResolvedValue({
        sub: 'user-1',
        token_use: 'refresh',
        family_id: 'family-1',
        device_id: '018bcfe5-6800-7abc-8def-0123456789ab',
        exp: Math.floor(Date.now() / 1000) + 60,
      }),
    } as unknown as JwtService;
    const service = new AuthService(prisma, redis, jwt, config, {} as FieldCryptoService, {} as OtpProvider);

    let thrown: unknown;
    try {
      await service.refresh({ refresh_token: refreshToken });
    } catch (error) {
      thrown = error;
    }

    expect(exceptionBody(thrown).code).toBe('LOCAL_DATA_PURGE_REQUIRED');
    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { familyId: 'family-1' },
    }));
    expect(tx.syncDevice.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: '018bcfe5-6800-7abc-8def-0123456789ab' }),
    }));
  });
});
