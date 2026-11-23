import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class HealthService {
  constructor(private readonly prisma: PrismaService, private readonly redis: RedisService) {}
  async check() {
    const checks: Record<string, 'ok' | 'error'> = { api: 'ok', database: 'error', redis: 'error' };
    try { await this.prisma.$queryRaw`SELECT 1`; checks.database = 'ok'; } catch { checks.database = 'error'; }
    try { await this.redis.ping(); checks.redis = 'ok'; } catch { checks.redis = 'error'; }
    const ok = Object.values(checks).every((value) => value === 'ok');
    return { status: ok ? 'ok' : 'error', checks, timestamp: new Date().toISOString() };
  }
}
