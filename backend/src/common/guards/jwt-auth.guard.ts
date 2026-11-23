import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppConfigService } from '../../config/config.module';
import { PrismaService } from '../../database/prisma.service';
import { IS_PUBLIC } from '../decorators/public.decorator';
import type { AuthenticatedUser } from '../decorators/current-user.decorator';
import type { RequestWithId } from '../middleware/request-id.middleware';

interface AccessPayload {
  sub: string;
  role: AuthenticatedUser['role'];
  token_use: 'access';
  device_id: string;
  exp?: number;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request & RequestWithId>();
    const authorization = request.header('authorization');
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    if (!match) throw this.authRequired();

    let payload: AccessPayload;
    try {
      // Se verifica siempre la firma. La expiración se evalúa después de consultar
      // usuario/dispositivo para poder ordenar la purga local aunque el access JWT
      // haya expirado desde que el usuario eliminó su cuenta en otro dispositivo.
      payload = await this.jwt.verifyAsync<AccessPayload>(match[1], {
        secret: this.config.value.jwtAccessSecret,
        algorithms: ['HS256'],
        issuer: 'vehicular-api',
        audience: 'vehicular-mobile',
        ignoreExpiration: true,
      });
    } catch {
      throw this.authRequired();
    }
    if (!payload.sub || payload.token_use !== 'access' || !payload.device_id || !Number.isFinite(payload.exp)) {
      throw this.authRequired();
    }
    const tokenExpired = (payload.exp as number) <= Math.floor(Date.now() / 1000);

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, role: true, status: true, deletedAt: true },
    });
    if (!user) throw this.authRequired();

    const isDeleteMe = request.method === 'DELETE' && /\/me\/?$/.test(request.path);
    if (user.status === 'deleted' || user.deletedAt || (user.status === 'deletion_pending' && !isDeleteMe)) {
      throw this.localPurgeRequired();
    }
    if (user.status === 'suspended' && !isDeleteMe) {
      throw new ForbiddenException({
        code: 'ACCOUNT_SUSPENDED',
        message: 'La cuenta está suspendida. Contacta con soporte.',
        details: {},
      });
    }

    const device = await this.prisma.syncDevice.findFirst({
      where: { id: payload.device_id, userId: user.id },
      select: { revokedAt: true, deletedAt: true },
    });
    if (!device || device.revokedAt || device.deletedAt) throw this.localPurgeRequired();
    if (tokenExpired && !(user.status === 'deletion_pending' && isDeleteMe)) throw this.authRequired();

    request.user = { id: user.id, role: user.role, device_id: payload.device_id } as AuthenticatedUser;
    return true;
  }

  private authRequired(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'AUTH_REQUIRED',
      message: 'Se requiere una sesión válida. Inicia sesión nuevamente.',
      details: {},
    });
  }

  private localPurgeRequired(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'LOCAL_DATA_PURGE_REQUIRED',
      message: 'La cuenta o el dispositivo fue eliminado o revocado. Borra todos los datos privados almacenados en este dispositivo.',
      details: { purge_local_data: true },
    });
  }
}
