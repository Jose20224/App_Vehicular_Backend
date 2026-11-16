import { Injectable, TooManyRequestsException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { AppConfigService } from '../../config/config.module';

@Injectable()
export class AssistanceRateLimitService {
  constructor(private readonly config: AppConfigService) {}

  async assertWithinLimit(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    // Serializa únicamente las altas de esta cuenta para que solicitudes concurrentes no superen el límite.
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 7))`);
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const count = await tx.assistanceRequest.count({ where: { userId, createdAt: { gte: since } } });
    const maximum = this.config.value.assistanceRequestMaxPerHour;
    if (count >= maximum) throw new TooManyRequestsException({
      code: 'ASSISTANCE_REQUEST_RATE_LIMITED',
      message: 'Alcanzaste el máximo de solicitudes de asistencia por hora. Inténtalo más tarde o usa los botones de llamada directa.',
      details: { maximum_per_hour: maximum, retry_after_seconds: 3600 },
    });
  }
}
