import { NotFoundException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { ResourceOwnerGuard } from '../../src/common/guards/resource-owner.guard';
import type { PrismaService } from '../../src/database/prisma.service';

function contextFor(id = '0192f2a0-7d2a-7c11-9d5a-123456789abc'): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({ params: { id }, user: { id: 'user-1', role: 'user', device_id: 'device-1' } }),
    }),
  } as unknown as ExecutionContext;
}

describe('ResourceOwnerGuard', () => {
  it('no ejecuta una consulta cuando el handler no declara recurso propietario', async () => {
    const reflector = { get: jest.fn().mockReturnValue(undefined) } as unknown as Reflector;
    const prisma = { $queryRaw: jest.fn() } as unknown as PrismaService;
    const guard = new ResourceOwnerGuard(reflector, prisma);

    await expect(guard.canActivate(contextFor())).resolves.toBe(true);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('permite un recurso que pertenece al usuario autenticado', async () => {
    const reflector = { get: jest.fn().mockReturnValue({ resource: 'vehicle', idParam: 'id' }) } as unknown as Reflector;
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ owned: true }]) } as unknown as PrismaService;
    const guard = new ResourceOwnerGuard(reflector, prisma);

    await expect(guard.canActivate(contextFor())).resolves.toBe(true);
  });

  it('devuelve 404 para recursos de otro propietario o inexistentes', async () => {
    const reflector = { get: jest.fn().mockReturnValue({ resource: 'vehicle', idParam: 'id' }) } as unknown as Reflector;
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ owned: false }]) } as unknown as PrismaService;
    const guard = new ResourceOwnerGuard(reflector, prisma);

    await expect(guard.canActivate(contextFor())).rejects.toBeInstanceOf(NotFoundException);
  });
});
