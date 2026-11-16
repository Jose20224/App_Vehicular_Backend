import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { RolesGuard } from '../../src/common/guards/roles.guard';

function contextFor(user?: { id: string; role: 'user' | 'workshop_owner' | 'provider_owner' | 'admin'; device_id: string }): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  it('permite cuando el rol autenticado está autorizado', () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(['admin', 'workshop_owner']) } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(contextFor({ id: 'u1', role: 'workshop_owner', device_id: 'd1' }))).toBe(true);
  });

  it('rechaza un rol no autorizado', () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(['admin']) } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(() => guard.canActivate(contextFor({ id: 'u1', role: 'user', device_id: 'd1' }))).toThrow(ForbiddenException);
  });

  it('no restringe handlers sin metadatos de roles', () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(contextFor())).toBe(true);
  });
});
