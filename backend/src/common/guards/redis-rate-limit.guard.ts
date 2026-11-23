import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { TooManyRequestsException } from '../exceptions/too-many-requests.exception';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { AppConfigService } from '../../config/config.module';
import { RedisService } from '../../redis/redis.service';
import { SKIP_RATE_LIMIT } from '../decorators/skip-rate-limit.decorator';
import type { AuthenticatedUser } from '../decorators/current-user.decorator';

const INCREMENT_FIXED_WINDOW_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return current
`;

@Injectable()
export class RedisRateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
    private readonly config: AppConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const clientIp = request.ip || request.socket.remoteAddress || 'unknown';
    const routeKey = `${request.method}:${request.path}`;
    // Las rutas autenticadas aíslan cuotas por cuenta y dispositivo; los
    // endpoints públicos conservan IP como identidad disponible.
    const identity = request.user
      ? `user:${request.user.id}:device:${request.user.device_id}`
      : `ip:${clientIp}`;
    const fingerprint = createHash('sha256').update(`${identity}:${routeKey}`).digest('hex');
    const key = `rate-limit:v1:${fingerprint}`;

    let count: number;
    try {
      count = Number(await this.redis.client.eval(
        INCREMENT_FIXED_WINDOW_SCRIPT,
        1,
        key,
        String(this.config.value.rateLimitTtlMs),
      ));
    } catch {
      throw new ServiceUnavailableException({
        code: 'RATE_LIMIT_STORE_UNAVAILABLE',
        message: 'No fue posible verificar el límite de solicitudes temporalmente.',
        details: {},
      });
    }

    if (count > this.config.value.rateLimitMaxRequests) {
      throw new TooManyRequestsException({
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Has enviado demasiadas solicitudes. Inténtalo nuevamente más tarde.',
        details: { retry_after_ms: this.config.value.rateLimitTtlMs },
      });
    }

    return true;
  }
}
