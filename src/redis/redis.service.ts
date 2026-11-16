import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '../config/config.module';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(config: AppConfigService) {
    this.client = new Redis(config.value.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      connectTimeout: 10_000,
      retryStrategy: (attempt) => (attempt > 3 ? null : Math.min(attempt * 250, 1000)),
    });
    this.client.on('error', (error) => {
      this.logger.error(`Redis reportó un error: ${error.message}`);
    });
  }

  async onModuleInit(): Promise<void> {
    if (this.client.status === 'wait') await this.client.connect();
    await this.client.ping();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client.status !== 'end') await this.client.quit();
  }

  ping(): Promise<string> {
    return this.client.ping();
  }
}
