import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AdBillingPeriod, AdCampaignStatus, AdMetricEventType, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../redis/redis.service';
import type { CreateAdCampaignDto, RecordAdMetricDto, ServeAdsQueryDto, UpsertAdPlanDto, UpsertAdSlotDto } from './dto/ads.dto';

const RESERVED_CAMPAIGN_STATUSES = [AdCampaignStatus.pending_payment, AdCampaignStatus.active, AdCampaignStatus.paused];
const CANCELLABLE_CAMPAIGN_STATUSES: AdCampaignStatus[] = [AdCampaignStatus.draft, AdCampaignStatus.pending_payment, AdCampaignStatus.active, AdCampaignStatus.paused];
const AD_SLOT_CODES = new Set(['featured_banner', 'sponsored_result', 'map_pin', 'premium_profile']);
const CACHE_TTL_SECONDS = 24 * 60 * 60;
const METRIC_WINDOW_MS = 30 * 60 * 1000;

@Injectable()
export class AdsService {
  constructor(private readonly prisma: PrismaService, private readonly redis: RedisService) {}

  async listPlans(): Promise<Record<string, unknown>[]> {
    const plans = await this.prisma.adPlan.findMany({ where: { isActive: true }, orderBy: [{ priceUsd: 'asc' }, { code: 'asc' }] });
    return plans.map((plan) => ({ ...plan, price_usd: Number(plan.priceUsd), nio_per_usd: Number(plan.nioPerUsd),
      quarterly_discount_percent: Number(plan.quarterlyDiscountPercent), annual_discount_percent: Number(plan.annualDiscountPercent) }));
  }

  async upsertPlan(dto: UpsertAdPlanDto): Promise<Record<string, unknown>> {
    this.validatePlan(dto);
    const data = { name: dto.name, description: dto.description ?? null, priceUsd: new Prisma.Decimal(dto.price_usd),
      durationDays: dto.duration_days ?? 30, quarterlyDiscountPercent: new Prisma.Decimal(dto.quarterly_discount_percent ?? 0),
      annualDiscountPercent: new Prisma.Decimal(dto.annual_discount_percent ?? 0), nioPerUsd: new Prisma.Decimal(dto.nio_per_usd ?? 36.7),
      features: dto.features as Prisma.InputJsonValue ?? {}, isActive: dto.is_active ?? true };
    const plan = await this.prisma.adPlan.upsert({ where: { code: dto.code }, create: { code: dto.code, ...data }, update: data });
    return { ...plan, price_usd: Number(plan.priceUsd), nio_per_usd: Number(plan.nioPerUsd) };
  }

  async upsertSlot(dto: UpsertAdSlotDto): Promise<Record<string, unknown>> {
    if (!AD_SLOT_CODES.has(dto.code)) throw new BadRequestException({ code: 'AD_SLOT_CODE_INVALID', message: 'El espacio publicitario no es válido.', details: { allowed: [...AD_SLOT_CODES] } });
    const max = dto.max_active_campaigns ?? 20;
    const perDepartment = dto.max_active_per_department ?? 3;
    if (!Number.isInteger(max) || max < 1 || !Number.isInteger(perDepartment) || perDepartment < 1) {
      throw new BadRequestException({ code: 'AD_SLOT_CAPACITY_INVALID', message: 'Los cupos deben ser enteros positivos.', details: {} });
    }
    return this.prisma.adSlot.upsert({ where: { code: dto.code },
      create: { code: dto.code, name: dto.name, description: dto.description ?? null, maxActiveCampaigns: max, maxActivePerDepartment: perDepartment, isActive: dto.is_active ?? true },
      update: { name: dto.name, description: dto.description ?? null, maxActiveCampaigns: max, maxActivePerDepartment: perDepartment, isActive: dto.is_active ?? true },
    });
  }

  async createCampaign(userId: string, role: 'workshop_owner' | 'provider_owner', dto: CreateAdCampaignDto): Promise<Record<string, unknown>> {
    if (Boolean(dto.workshop_id) === Boolean(dto.assistance_provider_id)) {
      throw new BadRequestException({ code: 'AD_TARGET_REQUIRED', message: 'Indica exactamente un taller o proveedor.', details: {} });
    }
    const [plan, slot] = await Promise.all([
      this.prisma.adPlan.findFirst({ where: { code: dto.plan_code, isActive: true } }),
      this.prisma.adSlot.findFirst({ where: { code: dto.slot_code, isActive: true } }),
    ]);
    if (!plan || !slot) throw new BadRequestException({ code: 'AD_PLAN_OR_SLOT_INVALID', message: 'El plan o espacio no existe o está inactivo.', details: {} });
    if (dto.workshop_id && role !== 'workshop_owner' || dto.assistance_provider_id && role !== 'provider_owner') {
      throw new BadRequestException({ code: 'AD_TARGET_ROLE_INVALID', message: 'El rol no corresponde al negocio que se promociona.', details: {} });
    }
    const target = dto.workshop_id
      ? await this.prisma.workshop.findFirst({ where: { id: dto.workshop_id, userId, deletedAt: null }, select: { id: true, departmentId: true, municipalityId: true } })
      : await this.prisma.assistanceProvider.findFirst({ where: { id: dto.assistance_provider_id!, userId, deletedAt: null }, select: { id: true, departmentId: true, municipalityId: true } });
    if (!target) throw new NotFoundException({ code: 'AD_TARGET_NOT_FOUND', message: 'No se encontró el negocio propio que se intenta promocionar.', details: {} });
    if (!target.departmentId) throw new BadRequestException({ code: 'AD_TARGET_DEPARTMENT_REQUIRED', message: 'El negocio debe tener un departamento para reservar su cupo.', details: {} });
    const startsAt = dto.starts_at ? new Date(dto.starts_at) : new Date();
    const now = new Date();
    if (startsAt.getTime() < now.getTime() - 60_000 || startsAt.getTime() > now.getTime() + 90 * 86400000) {
      throw new BadRequestException({ code: 'AD_START_DATE_INVALID', message: 'La fecha de inicio debe estar entre ahora y los próximos 90 días.', details: {} });
    }
    const months = dto.billing_period === AdBillingPeriod.monthly ? 1 : dto.billing_period === AdBillingPeriod.quarterly ? 3 : 12;
    const discount = dto.billing_period === AdBillingPeriod.quarterly ? Number(plan.quarterlyDiscountPercent)
      : dto.billing_period === AdBillingPeriod.annual ? Number(plan.annualDiscountPercent) : 0;
    const usd = Number(plan.priceUsd) * months * (1 - discount / 100);
    const rate = Number(plan.nioPerUsd);
    const endsAt = new Date(startsAt.getTime() + plan.durationDays * months * 86400000);
    const campaign = await this.prisma.adCampaign.create({ data: {
      userId, adPlanId: plan.id, adSlotId: slot.id, workshopId: dto.workshop_id ?? null,
      assistanceProviderId: dto.assistance_provider_id ?? null, departmentId: target.departmentId, municipalityId: target.municipalityId,
      campaignName: dto.campaign_name.trim(), billingPeriod: dto.billing_period, priceUsd: new Prisma.Decimal(usd),
      priceNioReference: new Prisma.Decimal(usd * rate), fxRateNioPerUsd: plan.nioPerUsd, startsAt, endsAt,
    } });
    return this.serializeCampaign(campaign);
  }

  async listMyCampaigns(userId: string): Promise<Record<string, unknown>[]> {
    const campaigns = await this.prisma.adCampaign.findMany({ where: { userId }, include: { plan: true, slot: true }, orderBy: { createdAt: 'desc' } });
    return campaigns.map((campaign) => this.serializeCampaign(campaign));
  }

  async submitCampaign(userId: string, id: string): Promise<Record<string, unknown>> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM public.ad_campaigns WHERE id = ${id}::uuid FOR UPDATE`);
      const campaign = await tx.adCampaign.findFirst({ where: { id, userId } });
      if (!campaign) throw this.notFound();
      if (campaign.status === AdCampaignStatus.pending_payment) return this.serializeCampaign(campaign);
      if (campaign.status !== AdCampaignStatus.draft) throw this.invalidTransition(campaign.status, AdCampaignStatus.pending_payment);
      await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${'ad-slot:' + campaign.adSlotId}, 9))`);
      await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${'ad-slot-department:' + campaign.adSlotId + ':' + campaign.departmentId}, 9))`);
      const [slot, total, department] = await Promise.all([
        tx.adSlot.findUniqueOrThrow({ where: { id: campaign.adSlotId } }),
        tx.adCampaign.count({ where: { adSlotId: campaign.adSlotId, status: { in: RESERVED_CAMPAIGN_STATUSES }, endsAt: { gt: new Date() } } }),
        tx.adCampaign.count({ where: { adSlotId: campaign.adSlotId, departmentId: campaign.departmentId, status: { in: RESERVED_CAMPAIGN_STATUSES }, endsAt: { gt: new Date() } } }),
      ]);
      if (total >= slot.maxActiveCampaigns || department >= slot.maxActivePerDepartment) {
        throw new ConflictException({ code: 'AD_SLOT_CAPACITY_REACHED', message: 'No hay cupo disponible para este espacio y departamento.', details: { total_capacity: slot.maxActiveCampaigns, department_capacity: slot.maxActivePerDepartment } });
      }
      const updated = await tx.adCampaign.update({ where: { id }, data: { status: AdCampaignStatus.pending_payment,
        paymentDueAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } });
      return this.serializeCampaign(updated);
    });
  }

  async confirmPayment(adminUserId: string, id: string): Promise<Record<string, unknown>> {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM public.ad_campaigns WHERE id = ${id}::uuid FOR UPDATE`);
      const campaign = await tx.adCampaign.findUnique({ where: { id } });
      if (!campaign) throw this.notFound();
      if (campaign.status !== AdCampaignStatus.pending_payment) throw this.invalidTransition(campaign.status, AdCampaignStatus.active);
      if (campaign.paymentConfirmedAt) return campaign;
      const now = new Date();
      if (campaign.paymentDueAt && campaign.paymentDueAt <= now) throw this.invalidTransition(campaign.status, AdCampaignStatus.cancelled);
      if (campaign.endsAt <= now) throw this.invalidTransition(campaign.status, AdCampaignStatus.expired);
      const activate = campaign.startsAt <= now && campaign.endsAt > now;
      return tx.adCampaign.update({ where: { id }, data: { paymentConfirmedAt: now, paymentConfirmedByUserId: adminUserId,
        ...(activate ? { status: AdCampaignStatus.active, sponsored: true } : {}) } });
    });
    await this.invalidateWorkshopDirectory();
    return this.serializeCampaign(result);
  }

  async pauseCampaign(userId: string, id: string): Promise<Record<string, unknown>> {
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM public.ad_campaigns WHERE id = ${id}::uuid FOR UPDATE`);
      const campaign = await tx.adCampaign.findFirst({ where: { id, userId } });
      if (!campaign) throw this.notFound();
      if (campaign.status !== AdCampaignStatus.active) throw this.invalidTransition(campaign.status, AdCampaignStatus.paused);
      return tx.adCampaign.update({ where: { id }, data: { status: AdCampaignStatus.paused, sponsored: false } });
    });
    await this.invalidateWorkshopDirectory();
    return this.serializeCampaign(updated);
  }

  async cancelCampaign(userId: string, id: string): Promise<Record<string, unknown>> {
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM public.ad_campaigns WHERE id = ${id}::uuid FOR UPDATE`);
      const campaign = await tx.adCampaign.findFirst({ where: { id, userId } });
      if (!campaign) throw this.notFound();
      if (!CANCELLABLE_CAMPAIGN_STATUSES.includes(campaign.status)) {
        throw this.invalidTransition(campaign.status, AdCampaignStatus.cancelled);
      }
      return tx.adCampaign.update({ where: { id }, data: { status: AdCampaignStatus.cancelled, sponsored: false } });
    });
    await this.invalidateWorkshopDirectory();
    return this.serializeCampaign(updated);
  }

  async serve(query: ServeAdsQueryDto): Promise<Record<string, unknown>> {
    const now = new Date();
    const campaigns = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${'ad-rotate:' + query.slot_code + ':' + query.department_id}, 9))`);
      const selected = await tx.adCampaign.findMany({ where: { status: AdCampaignStatus.active, sponsored: true, paymentConfirmedAt: { not: null },
        startsAt: { lte: now }, endsAt: { gt: now }, departmentId: query.department_id,
        ...(query.municipality_id ? { AND: [{ OR: [{ municipalityId: query.municipality_id }, { municipalityId: null }] }] } : {}), slot: { code: query.slot_code, isActive: true },
        OR: [{ workshop: { is: { status: 'active', deletedAt: null } } }, { assistanceProvider: { is: { status: 'active', verifiedAt: { not: null }, deletedAt: null } } }],
      }, include: { workshop: { select: { id: true, slug: true, name: true, description: true, municipalityId: true } },
        assistanceProvider: { select: { id: true, name: true, providerType: true, addressReferenceText: true, municipalityId: true } } },
        orderBy: [{ lastServedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }], take: query.limit });
      if (selected.length) await tx.adCampaign.updateMany({ where: { id: { in: selected.map((item) => item.id) } }, data: { lastServedAt: now } });
      return selected;
    });
    const workshopIds = campaigns.flatMap((campaign) => campaign.workshopId ? [campaign.workshopId] : []);
    const providerIds = campaigns.flatMap((campaign) => campaign.assistanceProviderId ? [campaign.assistanceProviderId] : []);
    const [workshopPoints, providerPoints] = await Promise.all([
      workshopIds.length ? this.prisma.$queryRaw<Array<{ id: string; latitude: number; longitude: number }>>(Prisma.sql`
        SELECT id, ST_Y(location::geometry) AS latitude, ST_X(location::geometry) AS longitude
        FROM public.workshops WHERE id IN (${Prisma.join(workshopIds.map((id) => Prisma.sql`${id}::uuid`))})
      `) : Promise.resolve([]),
      providerIds.length ? this.prisma.$queryRaw<Array<{ id: string; latitude: number; longitude: number }>>(Prisma.sql`
        SELECT id, ST_Y(base_location::geometry) AS latitude, ST_X(base_location::geometry) AS longitude
        FROM public.assistance_providers WHERE id IN (${Prisma.join(providerIds.map((id) => Prisma.sql`${id}::uuid`))})
      `) : Promise.resolve([]),
    ]);
    const pointsById = new Map([...workshopPoints, ...providerPoints].map((point) => [point.id, point]));
    return { items: campaigns.map((campaign) => ({
      campaign_id: campaign.id, slot_code: query.slot_code,
      target: campaign.workshop ? { type: 'workshop', id: campaign.workshop.id, slug: campaign.workshop.slug, name: campaign.workshop.name,
        description: campaign.workshop.description, municipality_id: campaign.workshop.municipalityId,
        latitude: pointsById.get(campaign.workshop.id)?.latitude ?? null, longitude: pointsById.get(campaign.workshop.id)?.longitude ?? null }
        : { type: 'assistance_provider', id: campaign.assistanceProvider!.id, name: campaign.assistanceProvider!.name,
          provider_type: campaign.assistanceProvider!.providerType, address_reference_text: campaign.assistanceProvider!.addressReferenceText,
          municipality_id: campaign.assistanceProvider!.municipalityId, latitude: pointsById.get(campaign.assistanceProvider!.id)?.latitude ?? null,
          longitude: pointsById.get(campaign.assistanceProvider!.id)?.longitude ?? null },
      patrocinado: true, sponsored: true,
      expires_at: new Date(Math.min(now.getTime() + CACHE_TTL_SECONDS * 1000, campaign.endsAt.getTime())).toISOString(),
      campaign_ends_at: campaign.endsAt.toISOString(),
    })), count: campaigns.length, cache_ttl_seconds: CACHE_TTL_SECONDS, generated_at: now.toISOString() };
  }

  async recordMetric(userId: string, dto: RecordAdMetricDto): Promise<Record<string, unknown>> {
    const now = new Date();
    const campaign = await this.prisma.adCampaign.findFirst({ where: { id: dto.campaign_id, status: AdCampaignStatus.active, sponsored: true,
      paymentConfirmedAt: { not: null }, startsAt: { lte: now }, endsAt: { gt: now } }, select: { id: true } });
    if (!campaign) throw this.notFound();
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ad-metric:${campaign.id}:${userId}:${dto.event_type}`}, 11))`);
      const recent = await tx.adMetric.findFirst({ where: { adCampaignId: campaign.id, userId, eventType: dto.event_type,
        createdAt: { gte: new Date(now.getTime() - METRIC_WINDOW_MS) } }, select: { id: true } });
      if (recent) return { recorded: true, duplicate: true, event_type: dto.event_type };
      await tx.adMetric.create({ data: { adCampaignId: campaign.id, userId, eventType: dto.event_type, windowStart: now } });
      return { recorded: true, duplicate: false, event_type: dto.event_type };
    });
  }

  async report(userId: string | undefined, id: string, from?: string, to?: string): Promise<Record<string, unknown>> {
    const campaign = await this.prisma.adCampaign.findFirst({ where: { id, ...(userId ? { userId } : {}) }, include: { plan: true, slot: true } });
    if (!campaign) throw this.notFound();
    const start = from ? new Date(from) : campaign.startsAt;
    const end = to ? new Date(to) : campaign.endsAt;
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
      throw new BadRequestException({ code: 'AD_REPORT_PERIOD_INVALID', message: 'El período del reporte no es válido.', details: {} });
    }
    const grouped = await this.prisma.adMetric.groupBy({ by: ['eventType'], where: { adCampaignId: id, createdAt: { gte: start, lt: end } }, _count: { _all: true } });
    const counts = Object.fromEntries(Object.values(AdMetricEventType).map((event) => [event, 0]));
    for (const row of grouped) counts[row.eventType] = row._count._all;
    return { campaign_id: id, campaign_name: campaign.campaignName, period: { from: start.toISOString(), to: end.toISOString() },
      status: campaign.status, currency: 'USD', price_usd: Number(campaign.priceUsd), price_nio_reference: Number(campaign.priceNioReference), metrics: counts };
  }

  async runDailyMaintenance(): Promise<{ activated: number; expired: number; released: number; warned: number }> {
    const now = new Date();
    const activated = await this.prisma.adCampaign.updateMany({ where: { status: AdCampaignStatus.pending_payment, paymentConfirmedAt: { not: null },
      startsAt: { lte: now }, endsAt: { gt: now } }, data: { status: AdCampaignStatus.active, sponsored: true } });
    const expired = await this.prisma.adCampaign.updateMany({ where: { status: { in: [AdCampaignStatus.active, AdCampaignStatus.paused] }, endsAt: { lte: now } }, data: { status: AdCampaignStatus.expired, sponsored: false } });
    const expiredBeforeStart = await this.prisma.adCampaign.updateMany({ where: { status: AdCampaignStatus.pending_payment,
      paymentConfirmedAt: { not: null }, endsAt: { lte: now } }, data: { status: AdCampaignStatus.expired, sponsored: false } });
    const released = await this.prisma.adCampaign.updateMany({ where: { status: AdCampaignStatus.pending_payment, paymentConfirmedAt: null,
      paymentDueAt: { lte: now } }, data: { status: AdCampaignStatus.cancelled, sponsored: false } });
    const warningEnd = new Date(now.getTime() + 7 * 86400000);
    const candidates = await this.prisma.adCampaign.findMany({ where: { status: { in: [AdCampaignStatus.active, AdCampaignStatus.paused] }, expiryWarningSentAt: null,
      endsAt: { gt: now, lte: warningEnd } }, select: { id: true, userId: true } });
    let warned = 0;
    for (const campaign of candidates) {
      await this.prisma.$transaction(async (tx) => {
        const claim = await tx.adCampaign.updateMany({ where: { id: campaign.id, status: AdCampaignStatus.active, expiryWarningSentAt: null }, data: { expiryWarningSentAt: now } });
        if (!claim.count) return;
        await tx.notificationLog.create({ data: { userId: campaign.userId, channel: 'in_app', provider: 'internal', status: 'sent',
          providerMessageId: `ad-expiry:${campaign.id}`, errorCode: 'AD_CAMPAIGN_EXPIRING_7_DAYS', sentAt: now } });
        warned++;
      });
    }
    if (activated.count || expired.count || expiredBeforeStart.count) await this.invalidateWorkshopDirectory();
    return { activated: activated.count, expired: expired.count + expiredBeforeStart.count, released: released.count, warned };
  }

  private serializeCampaign(campaign: { id: string; campaignName: string; status: AdCampaignStatus; billingPeriod: AdBillingPeriod;
    priceUsd: Prisma.Decimal; priceNioReference: Prisma.Decimal; startsAt: Date; endsAt: Date; sponsored: boolean }) {
    return { id: campaign.id, campaign_name: campaign.campaignName, status: campaign.status, billing_period: campaign.billingPeriod,
      price_usd: Number(campaign.priceUsd), price_nio_reference: Number(campaign.priceNioReference), currency: 'USD',
      starts_at: campaign.startsAt.toISOString(), ends_at: campaign.endsAt.toISOString(), sponsored: campaign.sponsored };
  }

  private async invalidateWorkshopDirectory(): Promise<void> {
    try { await this.redis.client.incr('directory:workshops:version'); } catch { /* La caché se refresca al vencer su TTL si Redis está temporalmente caído. */ }
  }

  private validatePlan(dto: UpsertAdPlanDto): void {
    const values = [dto.price_usd, dto.nio_per_usd ?? 36.7, dto.quarterly_discount_percent ?? 0, dto.annual_discount_percent ?? 0];
    if (values.some((value) => !Number.isFinite(value) || value < 0) || (dto.nio_per_usd ?? 36.7) === 0 ||
      (dto.quarterly_discount_percent ?? 0) > 100 || (dto.annual_discount_percent ?? 0) > 100 ||
      !Number.isInteger(dto.duration_days ?? 30) || (dto.duration_days ?? 30) < 1) {
      throw new BadRequestException({ code: 'AD_PLAN_VALUES_INVALID', message: 'El precio, duración, tipo de cambio o descuento del plan no es válido.', details: {} });
    }
  }

  private notFound(): NotFoundException { return new NotFoundException({ code: 'AD_CAMPAIGN_NOT_FOUND', message: 'No se encontró la campaña o no tienes acceso.', details: {} }); }
  private invalidTransition(from: AdCampaignStatus, to: AdCampaignStatus): ConflictException {
    return new ConflictException({ code: 'AD_CAMPAIGN_TRANSITION_INVALID', message: `No se permite cambiar la campaña de ${from} a ${to}.`, details: { from, to } });
  }
}
