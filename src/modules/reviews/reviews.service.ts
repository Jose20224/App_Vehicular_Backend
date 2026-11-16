import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { generateUuidV7 } from '../../common/uuid-v7';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../database/prisma.service';
import type { CreateReviewDto } from './dto/create-review.dto';
import type { CreateReviewReportDto } from './dto/create-review-report.dto';
import type { CreateReviewReplyDto } from './dto/create-review-reply.dto';
import type { ListReviewsQueryDto } from './dto/list-reviews-query.dto';
import type { ModerateReviewDto } from './dto/moderate-review.dto';

const SIX_MONTHS_COOLDOWN_ERROR = {
  code: 'REVIEW_COOLDOWN_ACTIVE',
  message: 'Ya existe una reseña para este taller dentro de los últimos seis meses.',
  details: { cooldown_months: 6 },
};

// Filtro inicial, deliberadamente sencillo. Todo contenido permanece pendiente
// de revisión humana; esta lista solo prioriza posibles insultos evidentes.
const OFFENSIVE_TERMS = [
  'puta', 'puto', 'putas', 'putos', 'mierda', 'joder', 'jodido', 'jodida',
  'pendejo', 'pendeja', 'pendejos', 'pendejas', 'idiota', 'idiotas',
  'imbecil', 'imbeciles', 'estupido', 'estupida', 'estupidos', 'estupidas',
  'cabron', 'cabrona', 'cabrones', 'malparido', 'malparida', 'coño',
] as const;

function normalizeForModeration(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es');
}

function containsOffensiveContent(value: string | null | undefined): boolean {
  if (!value) return false;
  const normalized = normalizeForModeration(value);
  return OFFENSIVE_TERMS.some((term) => {
    const normalizedTerm = normalizeForModeration(term);
    return new RegExp(`(^|[^a-z0-9])${normalizedTerm}([^a-z0-9]|$)`, 'i').test(normalized);
  });
}

function parseLimit(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new BadRequestException({
      code: 'INVALID_LIMIT',
      message: `limit debe ser un entero entre 1 y ${max}.`,
      details: { max },
    });
  }
  return parsed;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

@Injectable()
export class ReviewsService {
  constructor(private readonly prisma: PrismaService) {}

  async createReview(userId: string, dto: CreateReviewDto): Promise<Record<string, unknown>> {
    const comment = dto.comment?.trim() || null;
    const contentFlagged = containsOffensiveContent(comment);
    const reviewId = generateUuidV7();

    const review = await this.prisma.$transaction(async (tx) => {
      // El bloqueo serializa intentos simultáneos del mismo taller; la consulta
      // de enfriamiento se ejecuta con reloj PostgreSQL, no con el reloj móvil.
      const lockedWorkshop = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id
        FROM public.workshops
        WHERE id = ${dto.workshop_id}::uuid
          AND status = 'active'
          AND deleted_at IS NULL
        FOR UPDATE
      `);
      if (!lockedWorkshop.length) throw this.workshopNotAvailable();

      if (dto.vehicle_id) {
        const vehicle = await tx.vehicle.findFirst({
          where: { id: dto.vehicle_id, userId, deletedAt: null },
          select: { id: true },
        });
        if (!vehicle) {
          throw new BadRequestException({
            code: 'VEHICLE_NOT_OWNED',
            message: 'El vehículo indicado no existe o no pertenece a tu cuenta.',
            details: {},
          });
        }
      }

      const cooldown = await tx.$queryRaw<Array<{ has_recent_review: boolean }>>(Prisma.sql`
        SELECT EXISTS (
          SELECT 1
          FROM public.reviews
          WHERE user_id = ${userId}::uuid
            AND workshop_id = ${dto.workshop_id}::uuid
            AND created_at >= (clock_timestamp() - INTERVAL '6 months')
        ) AS has_recent_review
      `);
      if (cooldown[0]?.has_recent_review) throw new ConflictException(SIX_MONTHS_COOLDOWN_ERROR);

      return tx.review.create({
        data: {
          id: reviewId,
          userId,
          workshopId: dto.workshop_id,
          vehicleId: dto.vehicle_id ?? null,
          rating: dto.rating,
          comment,
          status: 'pending',
          contentFlagged,
          moderationReason: contentFlagged ? 'automatic_content_filter' : null,
        },
        select: {
          id: true,
          workshopId: true,
          rating: true,
          comment: true,
          status: true,
          contentFlagged: true,
          createdAt: true,
        },
      });
    });

    return {
      id: review.id,
      workshop_id: review.workshopId,
      rating: review.rating,
      comment: review.comment,
      status: review.status,
      content_flagged: review.contentFlagged,
      message: 'Tu reseña fue recibida y está pendiente de moderación.',
      created_at: review.createdAt,
    };
  }

  async listPublicReviews(workshopId: string, query: ListReviewsQueryDto): Promise<Record<string, unknown>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const workshop = await this.prisma.workshop.findFirst({
      where: { id: workshopId, status: 'active', deletedAt: null },
      select: { id: true, ratingAverage: true, ratingCount: true },
    });
    if (!workshop) throw this.workshopNotAvailable();

    const where: Prisma.ReviewWhereInput = {
      workshopId,
      status: 'published',
      deletedAt: null,
    };
    const [rows, total] = await Promise.all([
      this.prisma.review.findMany({
        where,
        orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          rating: true,
          comment: true,
          publishedAt: true,
          user: { select: { displayName: true } },
          reply: { select: { replyText: true, createdAt: true } },
        },
      }),
      this.prisma.review.count({ where }),
    ]);

    return {
      workshop_id: workshop.id,
      rating_average: Number(workshop.ratingAverage),
      rating_count: workshop.ratingCount,
      items: rows.map((row) => ({
        id: row.id,
        rating: row.rating,
        comment: row.comment,
        reviewer_name: row.user.displayName,
        published_at: row.publishedAt,
        reply: row.reply ? { text: row.reply.replyText, created_at: row.reply.createdAt } : null,
      })),
      page,
      limit,
      total,
      fetched_at: new Date().toISOString(),
    };
  }

  async listModerationQueue(limitInput?: string): Promise<Record<string, unknown>> {
    const limit = parseLimit(limitInput, 50, 100);
    const rows = await this.prisma.review.findMany({
      where: { status: 'pending', deletedAt: null },
      orderBy: [{ contentFlagged: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: {
        id: true,
        rating: true,
        comment: true,
        contentFlagged: true,
        moderationReason: true,
        createdAt: true,
        user: { select: { id: true, displayName: true } },
        workshop: { select: { id: true, name: true, slug: true } },
        vehicle: { select: { nickname: true, brandLabel: true, modelLabel: true } },
      },
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        rating: row.rating,
        comment: row.comment,
        content_flagged: row.contentFlagged,
        moderation_reason: row.moderationReason,
        created_at: row.createdAt,
        author: row.user,
        workshop: row.workshop,
        vehicle: row.vehicle,
      })),
      count: rows.length,
      limit,
      fetched_at: new Date().toISOString(),
    };
  }

  async moderateReview(adminUserId: string, reviewId: string, dto: ModerateReviewDto): Promise<Record<string, unknown>> {
    if (dto.decision !== 'approve' && !dto.reason?.trim()) {
      throw new BadRequestException({
        code: 'MODERATION_REASON_REQUIRED',
        message: 'Debes indicar el motivo para rechazar o retirar una reseña.',
        details: {},
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const identity = await tx.review.findUnique({
        where: { id: reviewId },
        select: { id: true, workshopId: true },
      });
      if (!identity) throw this.reviewNotFound();

      // Una fila del taller serializa moderaciones concurrentes sobre su reputación.
      await tx.$queryRaw(Prisma.sql`
        SELECT id FROM public.workshops WHERE id = ${identity.workshopId}::uuid FOR UPDATE
      `);
      // Releer después del lock evita que dos administradores apliquen decisiones
      // contradictorias usando el estado obsoleto que ambos vieron inicialmente.
      const current = await tx.review.findUnique({
        where: { id: reviewId },
        select: { id: true, workshopId: true, status: true },
      });
      if (!current) throw this.reviewNotFound();

      // El trigger SQL exige que este actor exista, esté activo y tenga rol admin.
      await tx.$queryRaw(Prisma.sql`
        SELECT set_config('app.actor_user_id', ${adminUserId}, TRUE)
      `);

      if (dto.decision === 'remove') {
        if (current.status !== 'published') {
          throw new ConflictException({
            code: 'REVIEW_NOT_PUBLISHED',
            message: 'Solo se puede retirar una reseña que ya fue publicada.',
            details: { current_status: current.status },
          });
        }
      } else if (current.status !== 'pending') {
        throw new ConflictException({
          code: 'REVIEW_ALREADY_MODERATED',
          message: 'La reseña ya fue moderada y no admite otra decisión.',
          details: { current_status: current.status },
        });
      }

      const nextStatus = dto.decision === 'approve' ? 'published' : dto.decision === 'reject' ? 'rejected' : 'removed';
      const updated = await tx.review.update({
        where: { id: reviewId },
        data: {
          status: nextStatus,
          moderationReason: dto.reason?.trim() || null,
          moderatedByUserId: adminUserId,
          moderatedAt: new Date(),
          ...(dto.decision === 'approve' ? { publishedAt: new Date() } : {}),
          ...(dto.decision === 'remove' ? { deletedAt: new Date() } : {}),
        },
        select: {
          id: true,
          workshopId: true,
          status: true,
          rating: true,
          moderationReason: true,
          moderatedAt: true,
        },
      });

      // El trigger de PostgreSQL recalcula promedio y total en esta misma
      // transacción; esta lectura confirma el snapshot resultante.
      const workshop = await tx.workshop.findUnique({
        where: { id: current.workshopId },
        select: { ratingAverage: true, ratingCount: true },
      });
      return {
        id: updated.id,
        status: updated.status,
        moderation_reason: updated.moderationReason,
        moderated_at: updated.moderatedAt,
        workshop_rating: workshop ? {
          average: Number(workshop.ratingAverage),
          count: workshop.ratingCount,
        } : null,
      };
    });
  }

  async replyToReview(
    ownerUserId: string,
    workshopId: string,
    reviewId: string,
    dto: CreateReviewReplyDto,
  ): Promise<Record<string, unknown>> {
    const workshop = await this.prisma.workshop.findFirst({
      where: { id: workshopId, userId: ownerUserId, status: 'active', deletedAt: null },
      select: { id: true },
    });
    if (!workshop) throw new ForbiddenException({
      code: 'WORKSHOP_OWNERSHIP_REQUIRED',
      message: 'Solo puedes responder reseñas de tu propio taller activo.',
      details: {},
    });

    const review = await this.prisma.review.findFirst({
      where: { id: reviewId, workshopId, status: 'published', deletedAt: null },
      select: { id: true },
    });
    if (!review) throw this.reviewNotFound();

    if (containsOffensiveContent(dto.reply_text)) {
      throw new BadRequestException({
        code: 'REPLY_CONTENT_REJECTED',
        message: 'La respuesta contiene expresiones que no se permiten publicar.',
        details: {},
      });
    }

    try {
      const reply = await this.prisma.reviewReply.create({
        data: {
          id: generateUuidV7(),
          reviewId,
          workshopId,
          userId: ownerUserId,
          replyText: dto.reply_text.trim(),
        },
        select: { id: true, reviewId: true, replyText: true, createdAt: true },
      });
      return {
        id: reply.id,
        review_id: reply.reviewId,
        reply_text: reply.replyText,
        created_at: reply.createdAt,
      };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          code: 'REVIEW_ALREADY_REPLIED',
          message: 'Este taller ya respondió esta reseña.',
          details: {},
        });
      }
      throw error;
    }
  }

  async reportReview(
    user: AuthenticatedUser,
    reviewId: string,
    dto: CreateReviewReportDto,
  ): Promise<Record<string, unknown>> {
    const review = await this.prisma.review.findFirst({
      where: { id: reviewId, status: 'published', deletedAt: null },
      select: { id: true, userId: true, workshopId: true },
    });
    if (!review) throw this.reviewNotFound();
    if (review.userId === user.id) {
      throw new BadRequestException({
        code: 'CANNOT_REPORT_OWN_REVIEW',
        message: 'No puedes reportar tu propia reseña.',
        details: {},
      });
    }

    if (user.role === 'workshop_owner') {
      const ownsWorkshop = await this.prisma.workshop.findFirst({
        where: { id: review.workshopId, userId: user.id, deletedAt: null },
        select: { id: true },
      });
      if (!ownsWorkshop) throw new ForbiddenException({
        code: 'WORKSHOP_OWNERSHIP_REQUIRED',
        message: 'Como propietario solo puedes reportar reseñas de tu propio taller.',
        details: {},
      });
    } else if (user.role !== 'user') {
      throw new ForbiddenException();
    }

    try {
      const report = await this.prisma.reviewReport.create({
        data: {
          id: generateUuidV7(),
          reviewId,
          reporterUserId: user.id,
          reporterRole: user.role,
          reason: dto.reason.trim(),
        },
        select: { id: true, reviewId: true, status: true, createdAt: true },
      });
      return {
        id: report.id,
        review_id: report.reviewId,
        status: report.status,
        created_at: report.createdAt,
        message: 'El reporte fue enviado a moderación.',
      };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          code: 'REVIEW_ALREADY_REPORTED',
          message: 'Ya tienes un reporte pendiente para esta reseña.',
          details: {},
        });
      }
      throw error;
    }
  }

  async listReports(statusInput?: string, limitInput?: string): Promise<Record<string, unknown>> {
    const limit = parseLimit(limitInput, 50, 100);
    let status: 'open' | 'resolved' | 'dismissed' | undefined;
    if (statusInput !== undefined && statusInput !== '') {
      if (!['open', 'resolved', 'dismissed'].includes(statusInput)) {
        throw new BadRequestException({
          code: 'INVALID_REPORT_STATUS',
          message: 'status debe ser open, resolved o dismissed.',
          details: {},
        });
      }
      status = statusInput as 'open' | 'resolved' | 'dismissed';
    }
    const rows = await this.prisma.reviewReport.findMany({
      where: status ? { status } : undefined,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: {
        id: true,
        reason: true,
        status: true,
        reporterRole: true,
        createdAt: true,
        review: { select: { id: true, rating: true, comment: true, workshop: { select: { id: true, name: true } } } },
        reporter: { select: { id: true, displayName: true } },
      },
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        reason: row.reason,
        status: row.status,
        reporter_role: row.reporterRole,
        created_at: row.createdAt,
        review: row.review,
        reporter: row.reporter,
      })),
      count: rows.length,
      limit,
      fetched_at: new Date().toISOString(),
    };
  }

  async resolveReport(adminUserId: string, reportId: string, status: 'resolved' | 'dismissed'): Promise<Record<string, unknown>> {
    const changed = await this.prisma.reviewReport.updateMany({
      where: { id: reportId, status: 'open' },
      data: { status, reviewedByUserId: adminUserId, reviewedAt: new Date() },
    });
    if (changed.count === 0) {
      const current = await this.prisma.reviewReport.findUnique({
        where: { id: reportId },
        select: { id: true, status: true },
      });
      if (!current) throw new NotFoundException({ code: 'REVIEW_REPORT_NOT_FOUND', message: 'No se encontró el reporte.', details: {} });
      throw new ConflictException({
        code: 'REVIEW_REPORT_ALREADY_RESOLVED',
        message: 'El reporte ya fue resuelto.',
        details: { current_status: current.status },
      });
    }

    const updated = await this.prisma.reviewReport.findUniqueOrThrow({
      where: { id: reportId },
      select: { id: true, status: true, reviewedAt: true },
    });
    return { id: updated.id, status: updated.status, reviewed_at: updated.reviewedAt };
  }

  private workshopNotAvailable(): NotFoundException {
    return new NotFoundException({
      code: 'WORKSHOP_NOT_FOUND',
      message: 'No se encontró un taller publicado disponible.',
      details: {},
    });
  }

  private reviewNotFound(): NotFoundException {
    return new NotFoundException({
      code: 'REVIEW_NOT_FOUND',
      message: 'No se encontró una reseña publicada disponible.',
      details: {},
    });
  }
}
