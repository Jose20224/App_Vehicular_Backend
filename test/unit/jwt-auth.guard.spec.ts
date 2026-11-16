import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from '../../src/common/guards/jwt-auth.guard';
import type { AppConfigService } from '../../src/config/config.module';
import type { PrismaService } from '../../src/database/prisma.service';

describe('JwtAuthGuard — borrado remoto', () => {
  it('ordena borrar los datos locales cuando la cuenta ya fue eliminada aunque el access token haya expirado', async () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as unknown as Reflector;
    const jwt = {
      verifyAsync: jest.fn().mockResolvedValue({
        sub: 'user-1', token_use: 'access', device_id: '018bcfe5-6800-7abc-8def-0123456789ab', exp: Math.floor(Date.now() / 1000) - 10,
      }),
    } as unknown as JwtService;
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({
        id: 'user-1', role: 'user', status: 'deleted', deletedAt: new Date(),
      }) },
      syncDevice: { findFirst: jest.fn() },
    } as unknown as PrismaService;
    const config = {
      value: { jwtAccessSecret: 'access-secret-for-unit-test-at-least-32-bytes' },
    } as AppConfigService;
    const guard = new JwtAuthGuard(reflector, jwt, prisma, config);
    const request = {
      header: jest.fn().mockReturnValue('Bearer access-token'),
      method: 'GET',
      path: '/api/v1/me',
    };
    const context = {
      getType: () => 'http',
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    let thrown: unknown;
    try {
      await guard.canActivate(context);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UnauthorizedException);
    expect((thrown as UnauthorizedException).getResponse()).toMatchObject({
      code: 'LOCAL_DATA_PURGE_REQUIRED',
      details: { purge_local_data: true },
    });
    expect(prisma.syncDevice.findFirst).not.toHaveBeenCalled();
  });

  it('permite reintentar DELETE /me con access token expirado mientras S3 mantiene deletion_pending', async () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as unknown as Reflector;
    const jwt = {
      verifyAsync: jest.fn().mockResolvedValue({
        sub: 'user-1', token_use: 'access', device_id: '018bcfe5-6800-7abc-8def-0123456789ab',
        exp: Math.floor(Date.now() / 1000) - 10,
      }),
    } as unknown as JwtService;
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({
        id: 'user-1', role: 'user', status: 'deletion_pending', deletedAt: null,
      }) },
      syncDevice: { findFirst: jest.fn().mockResolvedValue({ revokedAt: null, deletedAt: null }) },
    } as unknown as PrismaService;
    const config = { value: { jwtAccessSecret: 'access-secret-for-unit-test-at-least-32-bytes' } } as AppConfigService;
    const guard = new JwtAuthGuard(reflector, jwt, prisma, config);
    const request = {
      header: jest.fn().mockReturnValue('Bearer access-token'), method: 'DELETE', path: '/api/v1/me',
    };
    const context = {
      getType: () => 'http', getHandler: () => ({}), getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});
