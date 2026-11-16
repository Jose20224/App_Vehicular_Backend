import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../database/prisma.service';
import { RemindersService } from './reminders.service';
import { REMINDER_DISPATCH_JOB, REMINDER_QUEUE, REMINDER_SEND_JOB } from './reminder-queue.constants';

@Injectable()
export class ReminderQueueService implements OnModuleInit {
  private readonly logger = new Logger(ReminderQueueService.name);
  constructor(@InjectQueue(REMINDER_QUEUE) private readonly queue: Queue, private readonly prisma: PrismaService, private readonly reminders: RemindersService) {}

  async onModuleInit(): Promise<void> {
    await this.reminders.backfillMissingSchedules();
    await this.queue.add(REMINDER_DISPATCH_JOB, {}, {
      jobId: 'reminder-dispatcher-v1', repeat: { every: 60_000 }, removeOnComplete: 100, removeOnFail: 500,
    });
    await this.dispatchDue();
  }

  async dispatchDue(): Promise<number> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - 10 * 60 * 1000);
    await this.prisma.reminder.updateMany({ where: { status: 'processing', updatedAt: { lt: staleBefore }, deletedAt: null }, data: { status: 'scheduled' } });
    const due = await this.prisma.reminder.findMany({
      where: { status: 'scheduled', deletedAt: null, scheduledAt: { lte: now } },
      select: { id: true }, orderBy: { scheduledAt: 'asc' }, take: 500,
    });
    for (const reminder of due) {
      await this.queue.add(REMINDER_SEND_JOB, { reminderId: reminder.id }, {
        jobId: `reminder-${reminder.id}`, attempts: 6,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: 1000, removeOnFail: 2000,
      });
    }
    if (due.length === 500) this.logger.warn('Se alcanzó el lote máximo de despacho; el siguiente ciclo continuará la cola.');
    return due.length;
  }
}
