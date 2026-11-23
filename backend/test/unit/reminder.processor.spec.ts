import { ReminderProcessor } from '../../src/modules/reminders/reminder.processor';
import type { PrismaService } from '../../src/database/prisma.service';
import type { FcmService } from '../../src/modules/reminders/fcm.service';
import type { ReminderQueueService } from '../../src/modules/reminders/reminder-queue.service';

describe('ReminderProcessor', () => {
  it('no reenvía un recordatorio que ya fue reclamado o enviado antes del reinicio', async () => {
    const prisma = { reminder: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) } } as unknown as PrismaService;
    const fcm = { sendToUser: jest.fn() } as unknown as FcmService;
    const queue = {} as ReminderQueueService;
    const processor = new ReminderProcessor(prisma, fcm, queue);
    const result = await processor.process({ name: 'send-reminder', data: { reminderId: 'reminder-1' } } as never);
    expect(result).toEqual({ skipped: true });
    expect(fcm.sendToUser).not.toHaveBeenCalled();
  });
});
