import { ConflictException } from '@nestjs/common';
import { AdCampaignStatus, AdMetricEventType } from '../../src/generated/prisma/client';
import { AdsService } from '../../src/modules/ads/ads.service';
import type { PrismaService } from '../../src/database/prisma.service';
import type { RedisService } from '../../src/redis/redis.service';

type TestTransaction = {
  $queryRaw: jest.Mock;
  adCampaign: { findFirst: jest.Mock; count: jest.Mock; update: jest.Mock };
  adSlot: { findUniqueOrThrow: jest.Mock };
};

function campaign(id: string, status: AdCampaignStatus = AdCampaignStatus.draft) {
  return { id, userId: `owner-${id}`, adSlotId: 'slot-1', departmentId: 'dept-1', status, campaignName: id,
    billingPeriod: 'monthly' as const, priceUsd: 10, priceNioReference: 367, startsAt: new Date(Date.now() + 60_000),
    endsAt: new Date(Date.now() + 31 * 86400000), sponsored: false, paymentConfirmedAt: null };
}

function createCapacityFixture() {
  const records = new Map([['campaign-1', campaign('campaign-1')], ['campaign-2', campaign('campaign-2')]]);
  let lockTail = Promise.resolve();
  const transaction = async <T>(callback: (tx: TestTransaction) => Promise<T>): Promise<T> => {
    const releases: Array<() => void> = [];
    let advisoryLockCount = 0;
    const tx = {
      $queryRaw: jest.fn(async (query: { sql?: string }) => {
        if (query.sql?.includes('pg_advisory_xact_lock') && advisoryLockCount++ === 0) {
          const previous = lockTail;
          let release!: () => void;
          lockTail = new Promise<void>((resolve) => { release = resolve; });
          await previous;
          releases.push(release);
        }
        return [];
      }),
      adCampaign: {
        findFirst: jest.fn(async ({ where }: { where: { id: string; userId: string } }) => {
          const row = records.get(where.id);
          return row?.userId === where.userId ? row : null;
        }),
        findUniqueOrThrow: jest.fn(async () => ({ maxActiveCampaigns: 1, maxActivePerDepartment: 1 })),
        count: jest.fn(async ({ where }: { where: { departmentId?: string } }) => [...records.values()].filter((row) =>
          new Set<AdCampaignStatus>([AdCampaignStatus.pending_payment, AdCampaignStatus.active, AdCampaignStatus.paused]).has(row.status as AdCampaignStatus) &&
          (!where.departmentId || row.departmentId === where.departmentId)).length),
        update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = records.get(where.id)!;
          Object.assign(row, data);
          return row;
        }),
      },
      adSlot: { findUniqueOrThrow: jest.fn(async () => ({ maxActiveCampaigns: 1, maxActivePerDepartment: 1 })) },
    };
    try { return await callback(tx); } finally { releases.reverse().forEach((release) => release()); }
  };
  const prisma = { $transaction: transaction } as unknown as PrismaService;
  const service = new AdsService(prisma, {} as RedisService);
  return { service };
}

describe('AdsService B9', () => {
  it('reserva transaccionalmente el Ãºltimo cupo cuando dos campaÃ±as compiten a la vez', async () => {
    const { service } = createCapacityFixture();
    const results = await Promise.allSettled([
      service.submitCampaign('owner-campaign-1', 'campaign-1'),
      service.submitCampaign('owner-campaign-2', 'campaign-2'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') expect(rejected.reason).toBeInstanceOf(ConflictException);
  });

  it('no activa campaÃ±as que no tienen pago confirmado', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const prisma = { adCampaign: { updateMany, findMany: jest.fn().mockResolvedValue([]) } } as unknown as PrismaService;
    const service = new AdsService(prisma, {} as RedisService);

    await service.runDailyMaintenance();

    expect(updateMany.mock.calls[0][0].where).toEqual(expect.objectContaining({
      status: AdCampaignStatus.pending_payment,
      paymentConfirmedAt: { not: null },
    }));
  });

  it('expires active campaigns when their end date arrives', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const prisma = { adCampaign: { updateMany, findMany: jest.fn().mockResolvedValue([]) } } as unknown as PrismaService;
    const service = new AdsService(prisma, {} as RedisService);

    await service.runDailyMaintenance();

    expect(updateMany.mock.calls[1][0].where).toEqual(expect.objectContaining({
      status: { in: [AdCampaignStatus.active, AdCampaignStatus.paused] },
      endsAt: { lte: expect.any(Date) },
    }));
    expect(updateMany.mock.calls[1][0].data).toEqual({ status: AdCampaignStatus.expired, sponsored: false });
  });

  it('labels every served ad as sponsored', async () => {
    const row = { ...campaign('c1', AdCampaignStatus.active), sponsored: true, paymentConfirmedAt: new Date(),
      workshop: { id: 'w1', slug: 'taller-1', name: 'Taller 1', description: null, municipalityId: 'mun-1' },
      assistanceProvider: null };
    const tx = { $queryRaw: jest.fn(), adCampaign: { findMany: jest.fn().mockResolvedValue([row]), updateMany: jest.fn() } };
    const prisma = { $transaction: jest.fn((callback: (value: typeof tx) => unknown) => callback(tx)) } as unknown as PrismaService;
    const service = new AdsService(prisma, {} as RedisService);

    const result = await service.serve({ slot_code: 'sponsored_result', department_id: 'dept-1', limit: 3 });
    const items = result.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual(expect.objectContaining({ sponsored: true, patrocinado: true, expires_at: expect.any(String) }));
    expect(tx.adCampaign.updateMany).toHaveBeenCalled();
  });

  it('deduplica la misma acciÃ³n del usuario dentro de la ventana temporal', async () => {
    const tx = { $queryRaw: jest.fn(), adMetric: { findFirst: jest.fn().mockResolvedValue({ id: 'm1' }), create: jest.fn() } };
    const prisma = { $transaction: jest.fn((callback: (value: typeof tx) => unknown) => callback(tx)),
      adCampaign: { findFirst: jest.fn().mockResolvedValue({ id: 'c1' }) } } as unknown as PrismaService;
    const service = new AdsService(prisma, {} as RedisService);

    await expect(service.recordMetric('u1', { campaign_id: 'c1', event_type: AdMetricEventType.click }))
      .resolves.toEqual({ recorded: true, duplicate: true, event_type: 'click' });
    expect(tx.adMetric.create).not.toHaveBeenCalled();
  });
});
