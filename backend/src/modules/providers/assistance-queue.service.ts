import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ASSISTANCE_NOTIFICATION_QUEUE, ASSISTANCE_SEND_REQUEST_JOB } from './assistance-queue.constants';

@Injectable()
export class AssistanceQueueService {
  constructor(@InjectQueue(ASSISTANCE_NOTIFICATION_QUEUE) private readonly queue: Queue) {}

  async enqueueRequest(requestId: string): Promise<void> {
    await this.queue.add(ASSISTANCE_SEND_REQUEST_JOB, { requestId }, {
      jobId: `assistance-request-${requestId}-${Math.floor(Date.now() / 60_000)}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 15_000 },
      removeOnComplete: 1000,
      removeOnFail: 3000,
    });
  }
}
