import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { generateUuidV7 } from '../../common/uuid-v7';
import type { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';

const OFFSETS = [30, 15, 7, 1, 0];
const INCLUDE = { vehicleDocument: { include: { vehicle: { select: { nickname: true, brandLabel: true, modelLabel: true, vehicleType: true } } } } } as const;

@Injectable()
export class RemindersService {
  constructor(private readonly prisma: PrismaService) {}

  async preferences(userId: string): Promise<Record<string, unknown>> {
    const pref = await this.ensurePreferences(userId);
    return this.preferenceDto(pref);
  }

  async updatePreferences(userId: string, dto: UpdateNotificationPreferencesDto): Promise<Record<string, unknown>> {
    if (dto.enabled_offsets?.some((offset) => !OFFSETS.includes(offset))) throw new BadRequestException({ code: 'REMINDER_OFFSET_INVALID', message: 'Los días permitidos son 30, 15, 7, 1 y 0.', details: {} });
    const current = await this.ensurePreferences(userId);
    const updated = await this.prisma.$transaction(async (tx) => {
      const updatedPref = await tx.notificationPreference.update({ where: { id: current.id }, data: {
        ...(dto.enabled_offsets ? { enabledOffsets: dto.enabled_offsets } : {}),
        ...(dto.preferred_time ? { preferredTime: dto.preferred_time } : {}),
        ...(dto.push_enabled !== undefined ? { pushEnabled: dto.push_enabled } : {}),
        ...(dto.local_enabled !== undefined ? { localEnabled: dto.local_enabled } : {}),
        ...(dto.in_app_enabled !== undefined ? { inAppEnabled: dto.in_app_enabled } : {}),
      } });
      const docs = await tx.vehicleDocument.findMany({ where: { userId, deletedAt: null, validUntil: { not: null } }, select: { id: true } });
      for (const doc of docs) await this.regenerateForDocument(tx, userId, doc.id, updatedPref);
      return updatedPref;
    });
    return this.preferenceDto(updated);
  }

  async schedule(userId: string): Promise<Record<string, unknown>> {
    const pref = await this.ensurePreferences(userId);
    if (!pref.localEnabled) return { timezone: 'America/Managua', items: [], count: 0 };
    const now = new Date();
    const until = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
    const reminders = await this.prisma.reminder.findMany({
      where: { userId, status: 'scheduled', deletedAt: null, scheduledAt: { gt: now, lte: until } },
      include: INCLUDE, orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
    });
    const items = reminders.filter((r) => pref.enabledOffsets.includes(r.leadTimeDays)).map((r) => ({
      id: r.id, document_id: r.vehicleDocumentId, scheduled_at: r.scheduledAt.toISOString(),
      title: r.title, body: r.description, lead_time_days: r.leadTimeDays,
    }));
    return { timezone: 'America/Managua', generated_at: now.toISOString(), horizon_days: 90, items, count: items.length };
  }

  async listNotifications(userId: string, limit = 50): Promise<Record<string, unknown>> {
    const take = Math.max(1, Math.min(limit, 100));
    const items = await this.prisma.notificationLog.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take });
    return { items: items.map((n) => ({ id: n.id, reminder_id: n.reminderId, channel: n.channel, status: n.status, read_at: n.readAt?.toISOString() ?? null, sent_at: n.sentAt?.toISOString() ?? null, created_at: n.createdAt.toISOString() })), count: items.length };
  }

  async markRead(userId: string, notificationId: string): Promise<Record<string, unknown>> {
    const result = await this.prisma.notificationLog.updateMany({ where: { id: notificationId, userId, readAt: null }, data: { readAt: new Date() } });
    if (result.count === 0) {
      const exists = await this.prisma.notificationLog.findFirst({ where: { id: notificationId, userId } });
      if (!exists) throw new NotFoundException({ code: 'NOTIFICATION_NOT_FOUND', message: 'No se encontró la notificación.', details: {} });
    }
    return { id: notificationId, read: true };
  }

  async backfillMissingSchedules(): Promise<number> {
    let cursor: string | undefined;
    let processed = 0;
    while (true) {
      const documents = await this.prisma.vehicleDocument.findMany({
        where: { deletedAt: null, validUntil: { not: null }, user: { is: { status: 'active', deletedAt: null } }, vehicle: { is: { deletedAt: null } } },
        select: { id: true, userId: true }, orderBy: { id: 'asc' }, take: 500,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const doc of documents) {
        await this.prisma.$transaction(async (tx) => {
          await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${doc.id}, 0))`);
          const active = await tx.reminder.count({ where: { userId: doc.userId, vehicleDocumentId: doc.id, status: { in: ['scheduled', 'processing'] }, deletedAt: null } });
          if (active === 0) await this.regenerateForDocument(tx, doc.userId, doc.id);
        });
        processed += 1;
      }
      if (documents.length < 500) break;
      cursor = documents[documents.length - 1].id;
    }
    return processed;
  }

  async regenerateForDocument(tx: Prisma.TransactionClient, userId: string, documentId: string, knownPref?: Prisma.NotificationPreferenceGetPayload<Prisma.NotificationPreferenceDefaultArgs> | null): Promise<void> {
    await tx.reminder.updateMany({ where: { userId, vehicleDocumentId: documentId, status: { in: ['scheduled', 'processing'] }, deletedAt: null }, data: { status: 'cancelled', cancelledAt: new Date() } });
    const doc = await tx.vehicleDocument.findFirst({ where: { id: documentId, userId, deletedAt: null, validUntil: { not: null } }, include: { vehicle: { select: { nickname: true, brandLabel: true, modelLabel: true } }, insurancePolicy: { select: { status: true, deletedAt: true } } } });
    if (!doc?.validUntil || doc.insurancePolicy?.status === 'archived' || doc.insurancePolicy?.deletedAt) return;
    const pref = knownPref ?? await tx.notificationPreference.findFirst({ where: { userId, category: 'document_expiry', deletedAt: null } });
    if (pref && !pref.pushEnabled && !pref.localEnabled && !pref.inAppEnabled) return;
    const offsets = pref?.enabledOffsets ?? OFFSETS;
    const preferredTime = pref?.preferredTime ?? '09:00';
    const expiryDate = this.dateOnly(doc.validUntil);
    const vehicleName = doc.vehicle.nickname?.trim() || `${doc.vehicle.brandLabel} ${doc.vehicle.modelLabel}`.trim();
    const subject = doc.documentType === 'poliza' ? `Tu seguro del ${vehicleName}` : `Tu documento ${doc.title} del ${vehicleName}`;
    const now = new Date();
    const rows = OFFSETS.filter((offset) => offsets.includes(offset)).map((offset) => {
      const reminderDate = this.addDays(expiryDate, -offset);
      const scheduledAt = this.managuaDateTime(reminderDate, preferredTime);
      if (scheduledAt <= now) return null;
      const when = offset === 0 ? 'vence hoy' : `vence en ${offset} ${offset === 1 ? 'día' : 'días'}`;
      const message = `${subject} ${when}.`;
      return { id: generateUuidV7(), userId, vehicleDocumentId: documentId, title: message.slice(0, 120), description: `${message} Revisa los detalles para renovarlo a tiempo.`, dueAt: this.managuaDateTime(expiryDate, preferredTime), scheduledAt, leadTimeDays: offset, channel: 'push' };
    }).filter((r): r is NonNullable<typeof r> => r !== null);
    if (rows.length) await tx.reminder.createMany({ data: rows });
  }

  async cancelForDocument(tx: Prisma.TransactionClient, userId: string, documentId: string, at = new Date()): Promise<void> {
    await tx.reminder.updateMany({ where: { userId, vehicleDocumentId: documentId, status: { in: ['scheduled', 'processing'] }, deletedAt: null }, data: { status: 'cancelled', cancelledAt: at } });
  }

  private async ensurePreferences(userId: string) {
    const existing = await this.prisma.notificationPreference.findFirst({ where: { userId, category: 'document_expiry', deletedAt: null } });
    if (existing) return existing;
    try {
      return await this.prisma.notificationPreference.create({ data: { id: generateUuidV7(), userId, category: 'document_expiry' } });
    } catch (error) {
      const raced = await this.prisma.notificationPreference.findFirst({ where: { userId, category: 'document_expiry', deletedAt: null } });
      if (raced) return raced;
      throw error;
    }
  }

  private preferenceDto(p: { id: string; enabledOffsets: number[]; preferredTime: string; pushEnabled: boolean; localEnabled: boolean; inAppEnabled: boolean; timezone: string; updatedAt: Date }) {
    return { id: p.id, category: 'document_expiry', enabled_offsets: p.enabledOffsets, preferred_time: p.preferredTime, push_enabled: p.pushEnabled, local_enabled: p.localEnabled, in_app_enabled: p.inAppEnabled, timezone: p.timezone, updated_at: p.updatedAt.toISOString() };
  }

  private dateOnly(date: Date): string { return date.toISOString().slice(0, 10); }
  private addDays(date: string, days: number): string { const d = new Date(`${date}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
  private managuaDateTime(date: string, time: string): Date { return new Date(`${date}T${time}:00-06:00`); }
}
