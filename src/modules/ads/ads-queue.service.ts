import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ADS_DAILY_MAINTENANCE_JOB, ADS_QUEUE } from './ads-queue.constants';

@Injectable()
export class AdsQueueService implements OnModuleInit {
  constructor(@InjectQueue(ADS_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    await this.queue.add(ADS_DAILY_MAINTENANCE_JOB, {}, {
      jobId: `ads-daily-startup-${Date.now()}-${process.pid}`, attempts: 6,
      backoff: { type: 'exponential', delay: 30_000 }, removeOnComplete: 30, removeOnFail: 100,
    });
    await this.queue.add(ADS_DAILY_MAINTENANCE_JOB, {}, {
      jobId: 'ads-daily-maintenance-v1', repeat: { every: 24 * 60 * 60 * 1000 },
      attempts: 6, backoff: { type: 'exponential', delay: 30_000 }, removeOnComplete: 30, removeOnFail: 100,
    });
  }
}
