import { ServiceUnavailableException, TooManyRequestsException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { RedisRateLimitGuard } from '../../src/common/guards/redis-rate-limit.guard';
import type { RedisService } from '../../src/redis/redis.service';
import type { AppConfigService } from '../../src/config/config.module';

function contextFor(request: Record<string, unknown>): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('RedisRateLimitGuard', () => {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as unknown as Reflector;
  const config = { value: { rateLimitTtlMs: 60_000, rateLimitMaxRequests: 120 } } as AppConfigService;

  it('separa cuotas de rutas autenticadas por usuario y dispositivo', async () => {
    const evalMock = jest.fn().mockResolvedValue(1);
    const redis = { client: { eval: evalMock } } as unknown as RedisService;
    const guard = new RedisRateLimitGuard(reflector, redis, config);
    const request = {
      ip: '10.0.0.5', method: 'GET', path: '/api/v1/me',
      user: { id: 'user-1', role: 'user', device_id: 'device-1' },
    };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    const expected = createHash('sha256')
      .update('user:user-1:device:device-1:GET:/api/v1/me')
      .digest('hex');
    expect(evalMock).toHaveBeenCalledWith(expect.any(String), 1, `rate-limit:v1:${expected}`, '60000');
  });

  it('mantiene el rate limit por IP para endpoints públicos', async () => {
    const evalMock = jest.fn().mockResolvedValue(121);
    const redis = { client: { eval: evalMock } } as unknown as RedisService;
    const guard = new RedisRateLimitGuard(reflector, redis, config);

    await expect(guard.canActivate(contextFor({
      ip: '10.0.0.5', method: 'POST', path: '/api/v1/auth/otp/request', socket: { remoteAddress: '10.0.0.5' },
    }))).rejects.toBeInstanceOf(TooManyRequestsException);
  });

  it('falla cerrado si Redis no puede aplicar el límite', async () => {
    const redis = { client: { eval: jest.fn().mockRejectedValue(new Error('redis down')) } } as unknown as RedisService;
    const guard = new RedisRateLimitGuard(reflector, redis, config);
    await expect(guard.canActivate(contextFor({
      ip: '10.0.0.5', method: 'GET', path: '/api/v1/me', socket: { remoteAddress: '10.0.0.5' },
    }))).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
