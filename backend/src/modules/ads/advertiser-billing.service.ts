import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { AdCampaignStatus, AdPaymentStatus, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ObjectStorageService } from '../../storage/object-storage.service';
import { RedisService } from '../../redis/redis.service';
import type { PaymentGateway } from './payment-gateway/payment-gateway.interface';
import { PAYMENT_GATEWAY } from './payment-gateway/payment-gateway.interface';
import type { CompletePaymentProofDto, CreateProofUploadDto, RejectPaymentDto } from './dto/payments.dto';

const MAX_PROOF_BYTES = 10 * 1024 * 1024;

@Injectable()
export class AdvertiserBillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorageService,
    private readonly redis: RedisService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  async createOrder(userId: string, campaignId: string): Promise<Record<string, unknown>> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM public.ad_campaigns WHERE id = ${campaignId}::uuid FOR UPDATE`);
      const campaign = await tx.adCampaign.findFirst({ where: { id: campaignId, userId } });
      if (!campaign) throw this.notFound();
      if (campaign.status !== AdCampaignStatus.pending_payment || campaign.paymentConfirmedAt) throw new ConflictException({ code: 'AD_PAYMENT_ORDER_CAMPAIGN_INVALID', message: 'La campaña debe estar pendiente de pago para generar una orden.', details: {} });
      const existing = await tx.adPayment.findFirst({ where: { campaignId, status: { in: [AdPaymentStatus.pending, AdPaymentStatus.proof_received] } }, orderBy: { createdAt: 'desc' } });
      if (existing) return this.orderResponse(existing);
      const payment = await tx.adPayment.create({ data: { campaignId, userId, amountUsd: campaign.priceUsd, amountNioReference: campaign.priceNioReference } });
      return this.orderResponse(payment);
    });
  }

  async uploadUrl(userId: string, paymentId: string, dto: CreateProofUploadDto): Promise<Record<string, unknown>> {
    if (!Number.isInteger(dto.size_bytes) || dto.size_bytes < 1 || dto.size_bytes > MAX_PROOF_BYTES) throw new BadRequestException({ code: 'PAYMENT_PROOF_SIZE_INVALID', message: 'El comprobante debe pesar entre 1 byte y 10 MB.', details: { max_bytes: MAX_PROOF_BYTES } });
    const payment = await this.prisma.adPayment.findFirst({ where: { id: paymentId, userId } });
    if (!payment) throw this.notFound();
    if (payment.status !== AdPaymentStatus.pending && payment.status !== AdPaymentStatus.rejected) throw new ConflictException({ code: 'PAYMENT_PROOF_STATE_INVALID', message: 'Esta orden no admite un comprobante nuevo.', details: {} });
    const proofId = randomUUID();
    const key = `advertiser-payments/${paymentId}/${proofId}`;
    const signed = await this.storage.createUploadUrl(key, dto.content_type, dto.size_bytes);
    await this.prisma.adPaymentProof.create({ data: { id: proofId, paymentId, userId, objectKey: key, contentType: dto.content_type, sizeBytes: BigInt(dto.size_bytes) } });
    return { proof_id: proofId, upload_url: signed.url, expires_in_seconds: signed.expiresInSeconds, required_headers: signed.requiredHeaders, simulated: signed.simulated };
  }

  async completeProof(userId: string, paymentId: string, proofId: string, dto: CompletePaymentProofDto): Promise<Record<string, unknown>> {
    const proof = await this.prisma.adPaymentProof.findFirst({ where: { id: proofId, paymentId, userId, status: 'upload_pending' }, include: { payment: true } });
    if (!proof) throw this.notFound();
    const metadata = await this.storage.headObject(proof.objectKey);
    if (metadata.contentLength !== undefined && metadata.contentLength !== Number(proof.sizeBytes)) throw new ConflictException({ code: 'PAYMENT_PROOF_SIZE_MISMATCH', message: 'El tamaño del comprobante no coincide con el declarado.', details: {} });
    if (metadata.contentType && metadata.contentType !== proof.contentType) throw new ConflictException({ code: 'PAYMENT_PROOF_TYPE_MISMATCH', message: 'El tipo de comprobante no coincide con el declarado.', details: {} });
    const prefix = await this.storage.getObjectPrefix(proof.objectKey, 8);
    if (prefix && !matchesMime(proof.contentType, prefix)) throw new ConflictException({ code: 'PAYMENT_PROOF_CONTENT_INVALID', message: 'El contenido del comprobante no coincide con su tipo declarado.', details: {} });
    const normalized = dto.bank_reference.trim().replace(/\s+/g, '').toUpperCase();
    if (normalized.length < 4) throw new BadRequestException({ code: 'BANK_REFERENCE_INVALID', message: 'La referencia bancaria no es válida.', details: {} });
    const hash = createHash('sha256').update(normalized).digest('hex');
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.adPayment.update({ where: { id: paymentId }, data: { status: AdPaymentStatus.proof_received, bankReference: normalized, bankReferenceHash: hash, rejectionReason: null } });
        await tx.adPaymentProof.update({ where: { id: proofId }, data: { status: 'received', uploadedAt: new Date() } });
        await tx.adPaymentAuditLog.create({ data: { paymentId, actorId: userId, action: 'proof_submitted', metadata: { proof_id: proofId } } });
        return { payment_id: paymentId, status: AdPaymentStatus.proof_received };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException({ code: 'DUPLICATE_BANK_REFERENCE', message: 'Esta referencia bancaria ya fue registrada en otro pago.', details: {} });
      throw error;
    }
  }

  async listMine(userId: string): Promise<Record<string, unknown>> {
    const payments = await this.prisma.adPayment.findMany({ where: { userId }, include: { proofs: true, invoice: true, campaign: { select: { campaignName: true } } }, orderBy: { createdAt: 'desc' } });
    return { items: payments.map((p) => ({ id: p.id, campaign_name: p.campaign.campaignName, amount_usd: Number(p.amountUsd), amount_nio_reference: Number(p.amountNioReference), status: p.status, rejection_reason: p.rejectionReason, created_at: p.createdAt.toISOString(), invoice_number: p.invoice?.invoiceNumber ?? null })) };
  }

  async adminList(status?: string): Promise<Record<string, unknown>> {
    const rows = await this.prisma.adPayment.findMany({ where: status ? { status: status as AdPaymentStatus } : {}, include: { proofs: { orderBy: { createdAt: 'desc' } }, campaign: { select: { campaignName: true, startsAt: true, endsAt: true } }, user: { select: { displayName: true } } }, orderBy: { createdAt: 'asc' } });
    const items = await Promise.all(rows.map(async (p) => ({
      id: p.id, advertiser: p.user.displayName, campaign_name: p.campaign.campaignName,
      amount_usd: Number(p.amountUsd), amount_nio_reference: Number(p.amountNioReference), currency: p.currency,
      status: p.status, bank_reference: p.bankReference, rejection_reason: p.rejectionReason,
      created_at: p.createdAt.toISOString(),
      proofs: await Promise.all(p.proofs.map(async (f) => ({ id: f.id, status: f.status,
        download_url: f.status === 'received' ? (await this.storage.createDownloadUrl(f.objectKey)).url : null }))),
    })));
    return { items, count: items.length };
  }

  async approve(adminId: string, paymentId: string): Promise<Record<string, unknown>> {
    const invoice = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM public.ad_payments WHERE id = ${paymentId}::uuid FOR UPDATE`);
      const payment = await tx.adPayment.findUnique({ where: { id: paymentId }, include: { campaign: true, proofs: true } });
      if (!payment) throw this.notFound();
      if (payment.status === AdPaymentStatus.approved) return tx.adInvoice.findUnique({ where: { paymentId } });
      if (payment.status !== AdPaymentStatus.proof_received || !payment.proofs.some((p) => p.status === 'received')) throw new ConflictException({ code: 'PAYMENT_NOT_READY_FOR_APPROVAL', message: 'Se requiere un comprobante recibido antes de aprobar.', details: {} });
      await tx.$queryRaw(Prisma.sql`SELECT id FROM public.ad_campaigns WHERE id = ${payment.campaignId}::uuid FOR UPDATE`);
      const campaign = await tx.adCampaign.findUniqueOrThrow({ where: { id: payment.campaignId } });
      if (campaign.paymentConfirmedAt) throw new ConflictException({ code: 'CAMPAIGN_PAYMENT_ALREADY_CONFIRMED', message: 'Esta campaña ya tiene un pago aprobado.', details: {} });
      const now = new Date();
      if (campaign.endsAt <= now) throw new ConflictException({ code: 'CAMPAIGN_ALREADY_ENDED', message: 'No se puede aprobar el pago de una campaña ya terminada.', details: {} });
      await tx.adPayment.update({ where: { id: paymentId }, data: { status: AdPaymentStatus.approved, reviewedByUserId: adminId, reviewedAt: now, rejectionReason: null } });
      await tx.adCampaign.update({ where: { id: payment.campaignId }, data: { paymentConfirmedAt: now, paymentConfirmedByUserId: adminId,
        ...(campaign.startsAt <= now ? { status: AdCampaignStatus.active, sponsored: true } : { status: AdCampaignStatus.pending_payment, sponsored: false }) } });
      const seq = await tx.$queryRaw<Array<{ value: bigint }>>(Prisma.sql`SELECT nextval('public.ad_invoice_number_seq') AS value`);
      const year = now.getUTCFullYear();
      const issued = await tx.adInvoice.create({ data: { paymentId, userId: payment.userId, invoiceNumber: `FAC-${year}-${String(seq[0].value).padStart(8, '0')}`, amountUsd: payment.amountUsd, amountNioReference: payment.amountNioReference } });
      await tx.adPaymentAuditLog.create({ data: { paymentId, actorId: adminId, action: 'approved', metadata: { campaign_id: payment.campaignId, invoice_number: issued.invoiceNumber } } });
      return issued;
    });
    await this.invalidateDirectory();
    return { status: 'approved', invoice_number: invoice?.invoiceNumber, fiscal_format_status: 'pending_dgi_confirmation', message: 'Formato fiscal pendiente de confirmar con la normativa de la DGI.' };
  }

  async reject(adminId: string, paymentId: string, dto: RejectPaymentDto): Promise<Record<string, unknown>> {
    const reason = dto.reason.trim();
    if (!reason) throw new BadRequestException({ code: 'PAYMENT_REJECTION_REASON_REQUIRED', message: 'Indica el motivo del rechazo.', details: {} });
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM public.ad_payments WHERE id = ${paymentId}::uuid FOR UPDATE`);
      const payment = await tx.adPayment.findUnique({ where: { id: paymentId }, include: { campaign: true } });
      if (!payment) throw this.notFound();
      if (payment.status !== AdPaymentStatus.proof_received) throw new ConflictException({ code: 'PAYMENT_NOT_READY_FOR_REVIEW', message: 'El pago no tiene un comprobante pendiente de revisión.', details: {} });
      await tx.$queryRaw(Prisma.sql`SELECT id FROM public.ad_campaigns WHERE id = ${payment.campaignId}::uuid FOR UPDATE`);
      const campaign = await tx.adCampaign.findUniqueOrThrow({ where: { id: payment.campaignId } });
      if (campaign.paymentConfirmedAt) throw new ConflictException({ code: 'CAMPAIGN_PAYMENT_ALREADY_CONFIRMED', message: 'Esta campaña ya tiene un pago aprobado.', details: {} });
      await tx.adPayment.update({ where: { id: paymentId }, data: { status: AdPaymentStatus.rejected, rejectionReason: reason, reviewedByUserId: adminId, reviewedAt: new Date() } });
      await tx.adCampaign.update({ where: { id: payment.campaignId }, data: { status: AdCampaignStatus.pending_payment, sponsored: false, paymentConfirmedAt: null, paymentConfirmedByUserId: null, paymentDueAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } });
      await tx.adPaymentAuditLog.create({ data: { paymentId, actorId: adminId, action: 'rejected', metadata: { reason } } });
      return { payment_id: paymentId, status: 'rejected', reason };
    });
  }

  async exportCsv(type: 'payments' | 'invoices'): Promise<string> {
    if (type === 'payments') {
      const rows = await this.prisma.adPayment.findMany({ include: { campaign: { select: { campaignName: true } } }, orderBy: { createdAt: 'asc' } });
      return ['# Formato fiscal pendiente de confirmar con la normativa de la DGI', 'id,campana,referencia_bancaria,monto_usd,monto_nio_referencial,estado,creado_en', ...rows.map((p) => [p.id,p.campaign.campaignName,p.bankReference ?? '',p.amountUsd.toString(),p.amountNioReference.toString(),p.status,p.createdAt.toISOString()].map(csv).join(','))].join('\r\n');
    }
    const rows = await this.prisma.adInvoice.findMany({ orderBy: { issuedAt: 'asc' } });
    return ['# Formato fiscal pendiente de confirmar con la normativa de la DGI', 'numero,pago,monto_usd,monto_nio_referencial,moneda,formato_fiscal,emitida_en', ...rows.map((i) => [i.invoiceNumber,i.paymentId,i.amountUsd.toString(),i.amountNioReference.toString(),i.currency,i.fiscalFormatStatus,i.issuedAt.toISOString()].map(csv).join(','))].join('\r\n');
  }

  async reconcile(): Promise<Record<string, unknown>> {
    const pending = await this.prisma.adPayment.count({ where: { status: AdPaymentStatus.proof_received } });
    const duplicateHashes = await this.prisma.$queryRaw<Array<{ hash: string; count: bigint }>>(Prisma.sql`SELECT bank_reference_hash AS hash, count(*) AS count FROM public.ad_payments WHERE bank_reference_hash IS NOT NULL GROUP BY bank_reference_hash HAVING count(*) > 1`);
    return { pending_review: pending, duplicate_references: duplicateHashes.length, duplicates: duplicateHashes.map((r) => ({ reference_hash: r.hash, count: Number(r.count) })) };
  }

  async sendPaymentReminders(): Promise<{ pending: number; overdue: number }> {
    const now = new Date();
    const pending = await this.prisma.adPayment.findMany({ where: { status: AdPaymentStatus.pending, campaign: { paymentDueAt: { gt: now } }, OR: [{ lastReminderAt: null }, { lastReminderAt: { lt: new Date(now.getTime() - 24 * 3600000) } }] }, select: { id: true, userId: true } });
    const overdue = await this.prisma.adPayment.findMany({ where: { status: AdPaymentStatus.pending, campaign: { paymentDueAt: { lte: now } }, OR: [{ lastOverdueReminderAt: null }, { lastOverdueReminderAt: { lt: new Date(now.getTime() - 24 * 3600000) } }] }, select: { id: true, userId: true } });
    for (const [items, type] of [[pending, 'AD_PAYMENT_PENDING_REMINDER'], [overdue, 'AD_PAYMENT_OVERDUE_REMINDER']] as const) {
      for (const item of items) {
        await this.prisma.notificationLog.create({ data: { userId: item.userId, channel: 'in_app', provider: 'local', status: 'sent', providerMessageId: `ad-payment:${item.id}`, errorCode: type, sentAt: now } });
        await this.prisma.adPayment.update({ where: { id: item.id }, data: type === 'AD_PAYMENT_PENDING_REMINDER' ? { lastReminderAt: now } : { lastOverdueReminderAt: now } });
      }
    }
    return { pending: pending.length, overdue: overdue.length };
  }

  private orderResponse(p: { id: string; amountUsd: Prisma.Decimal; amountNioReference: Prisma.Decimal; currency: string }) {
    return { payment_id: p.id, amount_usd: Number(p.amountUsd), amount_nio_reference: Number(p.amountNioReference), currency: p.currency, status: 'pending', ...this.gateway.createInstructions({ paymentId: p.id, amountUsd: p.amountUsd.toString(), currency: p.currency }) };
  }
  private async invalidateDirectory(): Promise<void> { try { await this.redis.client.incr('directory:workshops:version'); } catch { /* cache TTL is fallback */ } }
  private notFound(): NotFoundException { return new NotFoundException({ code: 'AD_PAYMENT_NOT_FOUND', message: 'No se encontró el pago o no tienes acceso.', details: {} }); }
}

function csv(value: string): string {
  const safe = /^[=+@\-\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

function matchesMime(type: string, bytes: Buffer): boolean {
  if (type === 'application/pdf') return bytes.subarray(0, 5).toString('ascii') === '%PDF-';
  if (type === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return false;
}
