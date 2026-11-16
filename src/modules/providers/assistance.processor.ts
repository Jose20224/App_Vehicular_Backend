import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { ASSISTANCE_NOTIFICATION_QUEUE, ASSISTANCE_SEND_REQUEST_JOB } from './assistance-queue.constants';
import { ProvidersService } from './providers.service';

@Processor(ASSISTANCE_NOTIFICATION_QUEUE, { concurrency: 5 })
export class AssistanceProcessor extends WorkerHost {
  private readonly logger = new Logger(AssistanceProcessor.name);
  constructor(private readonly providers: ProvidersService) { super(); }

  async process(job: Job<{ requestId?: string }>): Promise<unknown> {
    if (job.name !== ASSISTANCE_SEND_REQUEST_JOB || !job.data.requestId) return null;
    try {
      return await this.providers.dispatchRequestNotification(job.data.requestId);
    } catch (error) {
      this.logger.warn(`No se pudo despachar la solicitud ${job.data.requestId}; BullMQ aplicará reintento. ${error instanceof Error ? error.message : 'error desconocido'}`);
      throw error;
    }
  }
}
