import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, WorkshopStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { CatalogsService, type EmergencyNumberInput } from '../catalogs/catalogs.service';

@Injectable()
export class B11BackofficeService {
  constructor(private readonly prisma: PrismaService, private readonly catalogs: CatalogsService) {}

  async claim(userId: string, kind: 'workshop' | 'provider', businessId: string, evidence?: string): Promise<Record<string, unknown>> {
    return this.prisma.$transaction(async (tx) => {
      const table = kind === 'workshop' ? 'workshops' : 'assistance_providers';
      const rows = await tx.$queryRaw<Array<{ id: string; is_preloaded: boolean }>>(Prisma.sql`SELECT id, is_preloaded FROM public.${Prisma.raw(table)} WHERE id = ${businessId}::uuid FOR UPDATE`);
      if (!rows.length) throw new NotFoundException({ code: 'PRELOADED_BUSINESS_NOT_FOUND', message: 'No se encontró el negocio precargado.', details: {} });
      if (!rows[0].is_preloaded) throw new ConflictException({ code: 'BUSINESS_ALREADY_CLAIMED', message: 'Este negocio ya fue reclamado.', details: {} });
      const where = kind === 'workshop' ? { workshopId: businessId } : { assistanceProviderId: businessId };
      const existing = await tx.businessClaim.findFirst({ where });
      if (existing && existing.status !== 'rejected') throw new ConflictException({ code: 'BUSINESS_ALREADY_CLAIMED', message: 'Este negocio ya tiene una reclamación en curso o fue reclamado.', details: {} });
      const claim = existing
        ? await tx.businessClaim.update({ where: { id: existing.id }, data: { userId, status: 'pending', evidence: evidence?.trim() ?? null, rejectionReason: null, reviewedAt: null, reviewedByUserId: null } })
        : await tx.businessClaim.create({ data: { userId, ...where, evidence: evidence?.trim() ?? null } });
      return { id: claim.id, status: claim.status, business_type: kind, business_id: businessId };
    });
  }

  async listClaims(status = 'pending'): Promise<Record<string, unknown>> {
    const rows = await this.prisma.businessClaim.findMany({ where: status === 'all' ? {} : { status }, include: {
      user: { select: { id: true, displayName: true } }, workshop: { select: { id: true, name: true, isPreloaded: true } },
      assistanceProvider: { select: { id: true, name: true, isPreloaded: true } },
    }, orderBy: { createdAt: 'asc' } });
    return { items: rows.map((r) => ({ id: r.id, owner: r.user, status: r.status, evidence: r.evidence,
      business: r.workshop ? { type: 'workshop', ...r.workshop } : { type: 'provider', ...r.assistanceProvider }, created_at: r.createdAt.toISOString() })), count: rows.length };
  }

  async reviewClaim(adminId: string, claimId: string, decision: 'approve' | 'reject', reason?: string): Promise<Record<string, unknown>> {
    if (decision === 'reject' && !reason?.trim()) throw new BadRequestException({ code: 'CLAIM_REJECTION_REASON_REQUIRED', message: 'Indica el motivo del rechazo.', details: {} });
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM public.business_claims WHERE id = ${claimId}::uuid FOR UPDATE`);
      const claim = await tx.businessClaim.findUnique({ where: { id: claimId }, include: { workshop: true, assistanceProvider: true } });
      if (!claim || claim.status !== 'pending') throw new ConflictException({ code: 'BUSINESS_CLAIM_NOT_PENDING', message: 'La reclamación ya fue procesada o no existe.', details: {} });
      const now = new Date();
      if (decision === 'approve' && claim.workshopId) {
        if (!claim.workshop?.isPreloaded) throw new ConflictException({ code: 'BUSINESS_ALREADY_CLAIMED', message: 'El negocio ya fue reclamado.', details: {} });
        await tx.workshop.update({ where: { id: claim.workshopId }, data: { userId: claim.userId, isPreloaded: false, status: WorkshopStatus.pending_verification, verifiedAt: null } });
      }
      if (decision === 'approve' && claim.assistanceProviderId) {
        if (!claim.assistanceProvider?.isPreloaded) throw new ConflictException({ code: 'BUSINESS_ALREADY_CLAIMED', message: 'El negocio ya fue reclamado.', details: {} });
        await tx.assistanceProvider.update({ where: { id: claim.assistanceProviderId }, data: { userId: claim.userId, isPreloaded: false, status: WorkshopStatus.pending_verification, verifiedAt: null } });
      }
      const updated = await tx.businessClaim.update({ where: { id: claimId }, data: { status: decision === 'approve' ? 'approved' : 'rejected', rejectionReason: decision === 'reject' ? reason!.trim() : null, reviewedByUserId: adminId, reviewedAt: now } });
      return { id: updated.id, status: updated.status, reviewed_at: updated.reviewedAt?.toISOString(), rejection_reason: updated.rejectionReason };
    });
  }

  async dashboard(): Promise<Record<string, unknown>> {
    const now = new Date();
    const expiringUntil = new Date(now.getTime() + 30 * 86400000);
    const [activeUsers, expiringDocuments, requests, incomeByPlan, occupancy] = await Promise.all([
      this.prisma.user.count({ where: { status: 'active', deletedAt: null } }),
      this.prisma.vehicleDocument.count({ where: { deletedAt: null, validUntil: { gte: now, lte: expiringUntil } } }),
      this.prisma.assistanceRequest.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.$queryRaw<Array<{ plan: string; invoices: bigint; revenue_usd: Prisma.Decimal }>>(Prisma.sql`SELECT ap.name AS plan, count(*) AS invoices, coalesce(sum(i.amount_usd),0) AS revenue_usd FROM public.ad_invoices i JOIN public.ad_payments p ON p.id=i.payment_id JOIN public.ad_campaigns c ON c.id=p.campaign_id JOIN public.ad_plans ap ON ap.id=c.ad_plan_id GROUP BY ap.name ORDER BY ap.name`),
      this.prisma.$queryRaw<Array<{ slot: string; department_id: string; capacity: number; occupied: bigint }>>(Prisma.sql`SELECT s.name AS slot, c.department_id, s.max_active_per_department AS capacity, count(*) AS occupied FROM public.ad_campaigns c JOIN public.ad_slots s ON s.id=c.ad_slot_id WHERE c.status IN ('pending_payment','active','paused') AND c.ends_at > now() GROUP BY s.name,c.department_id,s.max_active_per_department ORDER BY s.name,c.department_id`),
    ]);
    return { generated_at: now.toISOString(), active_users: activeUsers, documents_expiring_next_30_days: expiringDocuments,
      assistance_requests_by_status: requests.map((r) => ({ status: r.status, count: r._count._all })),
      income_by_plan: incomeByPlan.map((r) => ({ plan: r.plan, invoices: Number(r.invoices), revenue_usd: Number(r.revenue_usd) })),
      ad_slot_occupancy: occupancy.map((r) => ({ slot: r.slot, department_id: r.department_id, capacity: r.capacity, occupied: Number(r.occupied), utilization: r.capacity ? Number(r.occupied) / r.capacity : 0 })) };
  }

  async importEmergencyCsv(adminId: string, content: string): Promise<Record<string, unknown>> {
    const rows = parseCsv(content);
    if (rows.length < 2) throw new BadRequestException({ code: 'CSV_HEADER_REQUIRED', message: 'El CSV debe incluir encabezados y al menos una fila.', details: {} });
    const headers = rows[0].map((v) => v.trim().toLowerCase());
    const required = ['label', 'category', 'phone_number'];
    if (required.some((h) => !headers.includes(h))) throw new BadRequestException({ code: 'CSV_COLUMNS_INVALID', message: 'Encabezados requeridos: label,category,phone_number.', details: {} });
    let imported = 0;
    const failures: Array<{ row: number; reason: string }> = [];
    for (let index = 1; index < rows.length; index += 1) {
      if (rows[index].every((cell) => !cell.trim())) continue;
      const entry = Object.fromEntries(headers.map((header, column) => [header, rows[index][column]?.trim() ?? '']));
      try {
        if (!entry.label || !entry.category || !/^([+]\d{8,15}|\d{3,10})$/.test(entry.phone_number)) throw new Error('label, category o phone_number inválido.');
        const input: EmergencyNumberInput = { label: entry.label, category: entry.category, phone_number: entry.phone_number,
          department_id: entry.department_id || null, municipality_id: entry.municipality_id || null,
          source_name: entry.source_name || null, source_url: entry.source_url || null, notes: entry.notes || null, verified: false };
        await this.catalogs.createEmergencyNumber(input, adminId);
        imported += 1;
      } catch (error) { failures.push({ row: index + 1, reason: error instanceof Error ? error.message : 'Fila inválida.' }); }
    }
    return { imported, failed: failures.length, failures };
  }

  async setCatalogActive(adminId: string, catalog: string, id: string, isActive: boolean): Promise<Record<string, unknown>> {
    const tables: Record<string, string> = { 'vehicle-brands': 'vehicle_brands', 'vehicle-models': 'vehicle_models', insurers: 'insurers', 'service-types': 'service_types', specialties: 'specialties', departments: 'departments', municipalities: 'municipalities' };
    const table = tables[catalog];
    if (!table) throw new BadRequestException({ code: 'ADMIN_CATALOG_INVALID', message: 'Catálogo no administrable.', details: {} });
    const before = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM public.${Prisma.raw(table)} WHERE id = ${id}::uuid`);
    if (!before.length) throw new NotFoundException({ code: 'ADMIN_CATALOG_ITEM_NOT_FOUND', message: 'No se encontró el elemento del catálogo.', details: {} });
    await this.prisma.$executeRaw(Prisma.sql`UPDATE public.${Prisma.raw(table)} SET is_active = ${isActive} WHERE id = ${id}::uuid`);
    await this.prisma.catalogVersion.upsert({ where: { catalogName: catalog }, create: { catalogName: catalog, version: 1n }, update: { version: { increment: 1n }, updatedAt: new Date() } });
    return { id, catalog, is_active: isActive, updated_by: adminId };
  }
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted && char === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === ',') { row.push(cell); cell = ''; }
    else if (!quoted && (char === '\n' || char === '\r')) { if (char === '\r' && text[i + 1] === '\n') i += 1; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += char;
  }
  row.push(cell); if (row.some((v) => v)) rows.push(row);
  return rows;
}
