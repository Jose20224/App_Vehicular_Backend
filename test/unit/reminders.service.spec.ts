import { RemindersService } from '../../src/modules/reminders/reminders.service';
import type { PrismaService } from '../../src/database/prisma.service';

afterEach(() => jest.useRealTimers());

describe('RemindersService', () => {
  afterEach(() => jest.useRealTimers());

  it('crea el primer aviso al día siguiente cuando el documento vence en 31 días', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-04T12:00:00.000Z'));
    const expiry = new Date('2026-12-05T00:00:00.000Z');
    const tx = {
      reminder: { updateMany: jest.fn().mockResolvedValue({ count: 0 }), createMany: jest.fn().mockResolvedValue({ count: 5 }) },
      vehicleDocument: { findFirst: jest.fn().mockResolvedValue({ id: 'doc-1', documentType: 'poliza', title: 'Seguro', validUntil: expiry, insurancePolicy: { status: 'active', deletedAt: null }, vehicle: { nickname: 'Mi moto', brandLabel: 'Honda', modelLabel: 'CB' } }) },
      notificationPreference: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const service = new RemindersService({} as PrismaService);

    await service.regenerateForDocument(tx as never, 'user-1', 'doc-1');

    const rows = tx.reminder.createMany.mock.calls[0][0].data as Array<{ scheduledAt: Date; leadTimeDays: number; title: string; description: string }>;
    const first = rows.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())[0];
    expect(first.leadTimeDays).toBe(30);
    expect(first.scheduledAt.toISOString()).toBe('2026-11-05T15:00:00.000Z');
    expect(first.title).toContain('vence en 30 días');
  });

  it('no genera offsets desactivados y cancela la programación previa', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-04T12:00:00.000Z'));
    const tx = {
      reminder: { updateMany: jest.fn().mockResolvedValue({ count: 2 }), createMany: jest.fn().mockResolvedValue({ count: 1 }) },
      vehicleDocument: { findFirst: jest.fn().mockResolvedValue({ id: 'doc-2', documentType: 'circulacion', title: 'Circulación', validUntil: new Date('2026-11-20T00:00:00.000Z'), insurancePolicy: null, vehicle: { nickname: null, brandLabel: 'Toyota', modelLabel: 'Yaris' } }) },
      notificationPreference: { findFirst: jest.fn().mockResolvedValue({ enabledOffsets: [7], preferredTime: '09:00', pushEnabled: true, localEnabled: true, inAppEnabled: true }) },
    };
    const service = new RemindersService({} as PrismaService);

    await service.regenerateForDocument(tx as never, 'user-1', 'doc-2');

    expect(tx.reminder.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'cancelled' }) }));
    const rows = tx.reminder.createMany.mock.calls[0][0].data as Array<{ leadTimeDays: number }>;
    expect(rows.map((row) => row.leadTimeDays)).toEqual([7]);
  });
});

it('GET schedule devuelve solo offsets activos dentro del horizonte local', async () => {
  const now = new Date('2026-11-04T12:00:00.000Z');
  jest.useFakeTimers().setSystemTime(now);
  const prisma = {
    notificationPreference: { findFirst: jest.fn().mockResolvedValue({ id: 'pref-1', userId: 'user-1', category: 'document_expiry', enabledOffsets: [7], preferredTime: '09:00', pushEnabled: true, localEnabled: true, inAppEnabled: true, timezone: 'America/Managua', updatedAt: now }) },
    reminder: { findMany: jest.fn().mockResolvedValue([
      { id: 'r7', vehicleDocumentId: 'doc-1', scheduledAt: new Date('2026-11-10T15:00:00.000Z'), title: 'Seguro vence en 7 días', description: 'Texto listo', leadTimeDays: 7 },
      { id: 'r30', vehicleDocumentId: 'doc-1', scheduledAt: new Date('2026-11-05T15:00:00.000Z'), title: 'Seguro vence en 30 días', description: 'Texto listo', leadTimeDays: 30 },
    ]) },
  } as unknown as PrismaService;
  const service = new RemindersService(prisma);
  const result = await service.schedule('user-1');
  expect(result).toMatchObject({ timezone: 'America/Managua', horizon_days: 90, count: 1 });
  expect((result.items as Array<{ id: string }>).map((item) => item.id)).toEqual(['r7']);
});
