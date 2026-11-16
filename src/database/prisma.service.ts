import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '../generated/prisma/client';
import { AppConfigService } from '../config/config.module';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: AppConfigService) {
    const databaseUrl = new URL(config.value.databaseUrl);
    const schema = databaseUrl.searchParams.get('schema') ?? 'public';

    // Estos parámetros pertenecían al Query Engine de Prisma; el adaptador pg usa opciones nativas.
    databaseUrl.searchParams.delete('schema');
    databaseUrl.searchParams.delete('connection_limit');
    databaseUrl.searchParams.delete('pool_timeout');

    // SSL se configura explícitamente para que pg no reemplace el objeto TLS al parsear la URL.
    databaseUrl.searchParams.delete('sslmode');
    databaseUrl.searchParams.delete('sslrootcert');
    databaseUrl.searchParams.delete('sslcert');
    databaseUrl.searchParams.delete('sslkey');

    const ssl = config.value.databaseSslMode === 'disable'
      ? false
      : {
          rejectUnauthorized: config.value.databaseSslMode === 'verify-full',
          ...(config.value.databaseCaCertPath
            ? { ca: readFileSync(config.value.databaseCaCertPath, 'utf8') }
            : {}),
        };

    const adapter = new PrismaPg(
      {
        connectionString: databaseUrl.toString(),
        max: config.value.databasePoolMax,
        connectionTimeoutMillis: config.value.databasePoolTimeoutSeconds * 1000,
        idleTimeoutMillis: 30_000,
        ssl,
      },
      { schema },
    );
    super({ adapter });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
    } catch (error) {
      this.logger.error('No fue posible conectar con PostgreSQL.', error instanceof Error ? error.stack : undefined);
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
