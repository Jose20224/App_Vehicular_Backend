import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ADS_DAILY_MAINTENANCE_JOB, ADS_QUEUE } from './ads-queue.constants';
import { AdsService } from './ads.service';

@Processor(ADS_QUEUE, { concurrency: 1 })
export class AdsProcessor extends WorkerHost {
  constructor(private readonly ads: AdsService) { super(); }

  async process(job: Job): Promise<unknown> {
    if (job.name !== ADS_DAILY_MAINTENANCE_JOB) return null;
    return this.ads.runDailyMaintenance();
  }
}
