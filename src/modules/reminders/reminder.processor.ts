import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PrismaService } from '../../database/prisma.service';
import { FcmService } from './fcm.service';
import { REMINDER_DISPATCH_JOB, REMINDER_QUEUE, REMINDER_SEND_JOB } from './reminder-queue.constants';
import { ReminderQueueService } from './reminder-queue.service';

@Processor(REMINDER_QUEUE, { concurrency: 5 })
export class ReminderProcessor extends WorkerHost {
  private readonly logger = new Logger(ReminderProcessor.name);
  constructor(private readonly prisma: PrismaService, private readonly fcm: FcmService, private readonly queue: ReminderQueueService) { super(); }

  async process(job: Job<{ reminderId?: string }>): Promise<unknown> {
    if (job.name === REMINDER_DISPATCH_JOB) return this.queue.dispatchDue();
    if (job.name !== REMINDER_SEND_JOB || !job.data.reminderId) return null;
    const reminderId = job.data.reminderId;
    const claimed = await this.prisma.reminder.updateMany({
      where: { id: reminderId, status: 'scheduled', deletedAt: null, scheduledAt: { lte: new Date() } },
      data: { status: 'processing', attempts: { increment: 1 } },
    });
    if (claimed.count === 0) return { skipped: true };

    try {
      const reminder = await this.prisma.reminder.findUnique({
        where: { id: reminderId }, include: { user: { select: { id: true, status: true, deletedAt: true } }, vehicleDocument: { select: { id: true, deletedAt: true } } },
      });
      if (!reminder || reminder.user.status !== 'active' || reminder.user.deletedAt || reminder.vehicleDocument.deletedAt || reminder.status !== 'processing') {
        await this.prisma.reminder.updateMany({ where: { id: reminderId, status: 'processing' }, data: { status: 'cancelled', cancelledAt: new Date() } });
        return { cancelled: true };
      }
      const pref = await this.prisma.notificationPreference.findFirst({ where: { userId: reminder.userId, category: 'document_expiry', deletedAt: null } });
      if (pref && !pref.enabledOffsets.includes(reminder.leadTimeDays)) {
        await this.prisma.reminder.update({ where: { id: reminderId }, data: { status: 'cancelled', cancelledAt: new Date() } });
        return { cancelled: true, preference_disabled: true };
      }
      let pushSent = 0;
      let providerMessageId: string | null = null;
      const priorPush = await this.prisma.notificationLog.findFirst({ where: { reminderId: reminder.id, channel: 'push', status: 'sent' } });
      if ((!pref || pref.pushEnabled) && !priorPush) {
        const result = await this.fcm.sendToUser(reminder.userId, reminder.id, reminder.title, reminder.description ?? reminder.title);
        pushSent = result.sent;
        providerMessageId = result.messageIds[0] ?? null;
        if (result.failedCount > 0) throw new Error('FCM_TEMPORARY_FAILURE');
        if (result.sent > 0) {
          await this.prisma.notificationLog.createMany({ data: [{ userId: reminder.userId, reminderId: reminder.id, channel: 'push', provider: 'fcm', status: 'sent', providerMessageId, attemptCount: reminder.attempts, sentAt: new Date() }], skipDuplicates: true });
          await this.prisma.notificationLog.updateMany({ where: { reminderId: reminder.id, channel: 'push' }, data: { status: 'sent', providerMessageId, attemptCount: reminder.attempts, sentAt: new Date(), errorCode: null } });
        }
      }
      if (!pref || pref.inAppEnabled) {
        await this.prisma.notificationLog.createMany({ data: [{ userId: reminder.userId, reminderId: reminder.id, channel: 'in_app', provider: 'internal', status: 'sent', attemptCount: reminder.attempts, sentAt: new Date() }], skipDuplicates: true });
        await this.prisma.notificationLog.updateMany({ where: { reminderId: reminder.id, channel: 'in_app' }, data: { status: 'sent', attemptCount: reminder.attempts, sentAt: new Date() } });
      }
      const pushDelivered = Boolean(priorPush) || pushSent > 0;
      if ((!pref || pref.pushEnabled) && !pushDelivered && (!pref || !pref.inAppEnabled)) {
        await this.prisma.reminder.update({ where: { id: reminderId }, data: { status: 'failed' } });
        return { no_active_device: true };
      }
      await this.prisma.reminder.updateMany({ where: { id: reminderId, status: 'processing' }, data: { status: 'sent', sentAt: new Date() } });
      return { sent: pushDelivered, push_devices: pushSent };
    } catch (error) {
      const failedReminder = await this.prisma.reminder.findUnique({ where: { id: reminderId }, select: { userId: true } });
      if (failedReminder) {
        await this.prisma.notificationLog.createMany({ data: [{ userId: failedReminder.userId, reminderId, channel: 'push', provider: 'fcm', status: 'failed', errorCode: 'FCM_TEMPORARY_FAILURE', attemptCount: job.attemptsMade + 1 }], skipDuplicates: true }).catch(() => undefined);
        await this.prisma.notificationLog.updateMany({ where: { reminderId, channel: 'push', status: { not: 'sent' } }, data: { status: 'failed', errorCode: 'FCM_TEMPORARY_FAILURE', attemptCount: job.attemptsMade + 1 } }).catch(() => undefined);
      }
      const exhausted = job.attemptsMade + 1 >= Number(job.opts.attempts ?? 1);
      await this.prisma.reminder.updateMany({ where: { id: reminderId, status: 'processing' }, data: { status: exhausted ? 'failed' : 'scheduled' } });
      this.logger.warn('Falló el envío del recordatorio; BullMQ aplicará reintento con backoff.');
      throw error;
    }
  }
}
