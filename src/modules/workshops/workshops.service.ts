import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { FieldCryptoService, type EncryptedField } from '../../security/field-crypto.service';
import { ObjectStorageService } from '../../storage/object-storage.service';
import { RedisService } from '../../redis/redis.service';
import { generateUuidV7 } from '../../common/uuid-v7';
import type { CreateWorkshopDto } from './dto/create-workshop.dto';
import type { UpdateWorkshopDto } from './dto/update-workshop.dto';
import type { SearchWorkshopsQueryDto } from './dto/search-workshops-query.dto';
import type { CreateServiceOfferingDto } from './dto/create-service-offering.dto';
import type { UpdateServiceOfferingDto } from './dto/update-service-offering.dto';
import type { WorkshopPhotoUploadDto } from './dto/workshop-photo-upload.dto';

const PRICE_DISCLAIMER = 'Precio estimado. El pago se realiza directamente al taller o al proveedor cuando se presta el servicio.';
const DIRECTORY_CACHE_TTL_SECONDS = 60;
const OFFLINE_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const STALE_PRICE_AFTER_DAYS = 90;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const ALLOWED_PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const WEEK_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

interface WorkshopSearchRow {
  id: string;
  slug: string;
  latitude: number | null;
  longitude: number | null;
  distance_meters: number | null;
  is_open_now: boolean;
  sponsored: boolean;
}

interface ContactCipherColumns {
  phoneCiphertext?: Buffer | null;
  phoneNonce?: Buffer | null;
  phoneTag?: Buffer | null;
  phoneEncryptedDek?: Buffer | null;
  phoneKeyVersion?: string | null;
  phoneAadVersion?: number | null;
  whatsappCiphertext?: Buffer | null;
  whatsappNonce?: Buffer | null;
  whatsappTag?: Buffer | null;
  whatsappEncryptedDek?: Buffer | null;
  whatsappKeyVersion?: string | null;
  whatsappAadVersion?: number | null;
  emailCiphertext?: Buffer | null;
  emailNonce?: Buffer | null;
  emailTag?: Buffer | null;
  emailEncryptedDek?: Buffer | null;
  emailKeyVersion?: string | null;
  emailAadVersion?: number | null;
}
interface WorkshopContactRecord {
  id: string;
  userId: string;
  phoneCiphertext: Uint8Array | null;
  phoneNonce: Uint8Array | null;
  phoneTag: Uint8Array | null;
  phoneEncryptedDek: Uint8Array | null;
  phoneKeyVersion: string | null;
  phoneAadVersion: number | null;
  whatsappCiphertext: Uint8Array | null;
  whatsappNonce: Uint8Array | null;
  whatsappTag: Uint8Array | null;
  whatsappEncryptedDek: Uint8Array | null;
  whatsappKeyVersion: string | null;
  whatsappAadVersion: number | null;
  emailCiphertext: Uint8Array | null;
  emailNonce: Uint8Array | null;
  emailTag: Uint8Array | null;
  emailEncryptedDek: Uint8Array | null;
  emailKeyVersion: string | null;
  emailAadVersion: number | null;
}

@Injectable()
export class WorkshopsService {
  private readonly logger = new Logger(WorkshopsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: FieldCryptoService,
    private readonly storage: ObjectStorageService,
    private readonly redis: RedisService,
  ) {}

  async createWorkshop(userId: string, dto: CreateWorkshopDto): Promise<Record<string, unknown>> {
    this.assertCoordinatePair(dto.latitude, dto.longitude);
    this.validateWeeklySchedule(dto.weekly_schedule ?? {});
    await this.assertMunicipality(dto.department_id ?? null, dto.municipality_id ?? null);

    const existing = await this.prisma.workshop.findUnique({ where: { id: dto.id }, select: { id: true, userId: true, deletedAt: true, name: true, status: true } });
    if (existing) {
      if (existing.userId !== userId) throw this.idCollision();
      if (existing.deletedAt) throw new ConflictException({
        code: 'WORKSHOP_ID_RETIRED',
        message: 'Este identificador ya pertenece a un taller retirado y no puede reutilizarse.',
        details: {},
      });
      if (existing.name !== dto.name.trim()) throw new ConflictException({
        code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
        message: 'El identificador del taller ya fue utilizado con datos diferentes.',
        details: {},
      });
      return { id: existing.id, status: existing.status, idempotent_replay: true };
    }

    const slug = await this.uniqueSlug(dto.name, dto.id);
    const contact = await this.encryptContacts(userId, dto.id, dto);
    const record = await this.prisma.$transaction(async (tx) => {
      const created = await tx.workshop.create({
        data: {
          id: dto.id,
          userId,
          name: dto.name.trim(),
          slug,
          description: dto.description?.trim() || null,
          address: dto.address?.trim() || null,
          addressReferenceText: dto.address_reference_text?.trim() || null,
          departmentId: dto.department_id ?? null,
          municipalityId: dto.municipality_id ?? null,
          weeklySchedule: (dto.weekly_schedule ?? {}) as Prisma.InputJsonValue,
          ...contact,
        },
        select: { id: true, slug: true, name: true, status: true, createdAt: true },
      });
      if (dto.latitude !== undefined && dto.longitude !== undefined) {
        await tx.$executeRaw(Prisma.sql`
          UPDATE public.workshops
          SET location = ST_SetSRID(ST_MakePoint(${dto.longitude}, ${dto.latitude}), 4326)::geography
          WHERE id = ${dto.id}::uuid AND user_id = ${userId}::uuid
        `);
      }
      return created;
    });
    await this.invalidateDirectoryCache();
    return { ...record, status: record.status, idempotent_replay: false };
  }

  async updateWorkshop(userId: string, id: string, dto: UpdateWorkshopDto): Promise<Record<string, unknown>> {
    this.assertCoordinatePair(dto.latitude, dto.longitude);
    if (dto.weekly_schedule !== undefined) this.validateWeeklySchedule(dto.weekly_schedule);
    const existing = await this.prisma.workshop.findFirst({ where: { id, userId, deletedAt: null } });
    if (!existing) throw this.workshopNotFound();

    const departmentId = dto.department_id !== undefined ? dto.department_id : existing.departmentId;
    const municipalityId = dto.municipality_id !== undefined ? dto.municipality_id : existing.municipalityId;
    await this.assertMunicipality(departmentId, municipalityId);

    const data: Prisma.WorkshopUncheckedUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.description !== undefined) data.description = dto.description?.trim() || null;
    if (dto.address !== undefined) data.address = dto.address?.trim() || null;
    if (dto.address_reference_text !== undefined) data.addressReferenceText = dto.address_reference_text?.trim() || null;
    if (dto.department_id !== undefined) data.departmentId = dto.department_id;
    if (dto.municipality_id !== undefined) data.municipalityId = dto.municipality_id;
    if (dto.weekly_schedule !== undefined) data.weeklySchedule = dto.weekly_schedule as Prisma.InputJsonValue;
    Object.assign(data, await this.encryptContacts(userId, id, dto, true));

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.workshop.update({ where: { id }, data, select: { id: true, slug: true, name: true, status: true, updatedAt: true } });
      if (dto.latitude !== undefined && dto.longitude !== undefined) {
        await tx.$executeRaw(Prisma.sql`
          UPDATE public.workshops
          SET location = ST_SetSRID(ST_MakePoint(${dto.longitude}, ${dto.latitude}), 4326)::geography
          WHERE id = ${id}::uuid AND user_id = ${userId}::uuid
        `);
      }
      return row;
    });
    await this.invalidateDirectoryCache();
    return updated;
  }

  async getOwnedWorkshops(userId: string): Promise<Record<string, unknown>> {
    const records = await this.prisma.workshop.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      select: {
        id: true, slug: true, name: true, status: true, address: true, addressReferenceText: true,
        createdAt: true, updatedAt: true, verifiedAt: true,
        department: { select: { id: true, name: true } },
        municipality: { select: { id: true, name: true } },
        _count: { select: { specialties: true, photos: true, serviceOfferings: true } },
      },
    });
    return {
      items: records.map((record) => ({
        id: record.id, slug: record.slug, name: record.name, status: record.status,
        address: record.address, address_reference_text: record.addressReferenceText,
        department: record.department, municipality: record.municipality,
        created_at: record.createdAt, updated_at: record.updatedAt, verified_at: record.verifiedAt,
        counts: { specialties: record._count.specialties, photos: record._count.photos, service_offerings: record._count.serviceOfferings },
      })),
      count: records.length,
      fetched_at: new Date().toISOString(),
    };
  }

  async getOwnedWorkshop(userId: string, id: string): Promise<Record<string, unknown>> {
    const record = await this.prisma.workshop.findFirst({
      where: { id, userId, deletedAt: null },
      include: {
        department: { select: { id: true, name: true } },
        municipality: { select: { id: true, name: true } },
        specialties: { where: { deletedAt: null }, include: { specialty: { select: { id: true, name: true, isActive: true } } } },
        photos: { where: { deletedAt: null }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], take: 100, select: { id: true, altText: true, sortOrder: true, status: true, objectKey: true } },
        serviceOfferings: { where: { deletedAt: null }, include: { serviceType: { select: { id: true, name: true } } }, orderBy: [{ name: 'asc' }], take: 50 },
      },
    });
    if (!record) throw this.workshopNotFound();
    const [phone, whatsapp, email, location] = await Promise.all([
      this.decryptContact(record, 'phone'),
      this.decryptContact(record, 'whatsapp'),
      this.decryptContact(record, 'email'),
      this.prisma.$queryRaw<Array<{ latitude: number | null; longitude: number | null }>>(Prisma.sql`
        SELECT ST_Y(location::geometry) AS latitude, ST_X(location::geometry) AS longitude
        FROM public.workshops WHERE id = ${id}::uuid AND user_id = ${userId}::uuid
      `),
    ]);
    const photos = await Promise.all(record.photos.map(async (photo) => {
      if (photo.status !== 'published') return { id: photo.id, alt_text: photo.altText, sort_order: photo.sortOrder, status: photo.status, url: null };
      const signed = await this.storage.createDownloadUrl(photo.objectKey);
      return { id: photo.id, alt_text: photo.altText, sort_order: photo.sortOrder, status: photo.status, url: signed.url };
    }));
    return {
      id: record.id, slug: record.slug, name: record.name, description: record.description, status: record.status,
      address: record.address, address_reference_text: record.addressReferenceText,
      department: record.department, municipality: record.municipality,
      latitude: location[0]?.latitude ?? null, longitude: location[0]?.longitude ?? null,
      weekly_schedule: record.weeklySchedule, is_open_now: this.isOpenNow(record.weeklySchedule as Record<string, unknown>),
      contacts: { phone, whatsapp, email },
      specialties: record.specialties.map((item) => item.specialty), photos,
      service_offerings: record.serviceOfferings.map((item) => this.serializeOffering(item)),
      rating_average: Number(record.ratingAverage), rating_count: record.ratingCount,
      created_at: record.createdAt, updated_at: record.updatedAt, verified_at: record.verifiedAt,
      fetched_at: new Date().toISOString(),
      ...(record.serviceOfferings.length ? { pricing_disclaimer: PRICE_DISCLAIMER } : {}),
    };
  }

  async submitForVerification(userId: string, id: string): Promise<Record<string, unknown>> {
    const record = await this.prisma.workshop.findFirst({ where: { id, userId, deletedAt: null } });
    if (!record) throw this.workshopNotFound();
    if (!record.address?.trim() || !record.addressReferenceText?.trim() || !record.departmentId || !record.municipalityId) {
      throw new BadRequestException({
        code: 'WORKSHOP_PROFILE_INCOMPLETE',
        message: 'Completa dirección, referencia local, ubicación y municipio antes de solicitar verificación.',
        details: { required_fields: ['address', 'address_reference_text', 'department_id', 'municipality_id', 'location'] },
      });
    }
    const location = await this.prisma.$queryRaw<Array<{ has_location: boolean }>>(Prisma.sql`
      SELECT location IS NOT NULL AS has_location FROM public.workshops WHERE id = ${id}::uuid AND user_id = ${userId}::uuid
    `);
    if (!location[0]?.has_location) throw new BadRequestException({
      code: 'WORKSHOP_LOCATION_REQUIRED',
      message: 'Registra la ubicación geográfica antes de solicitar verificación.',
      details: {},
    });
    const updated = await this.prisma.workshop.update({
      where: { id }, data: { status: 'pending_verification' },
      select: { id: true, status: true, updatedAt: true },
    });
    await this.invalidateDirectoryCache();
    return updated;
  }

  async updateStatusByAdmin(id: string, status: 'active' | 'suspended' | 'pending_verification'): Promise<Record<string, unknown>> {
    const record = await this.prisma.workshop.findFirst({ where: { id, deletedAt: null } });
    if (!record) throw this.workshopNotFound();
    if (status === 'active') {
      if (!record.addressReferenceText?.trim() || !record.address?.trim() || !record.departmentId || !record.municipalityId) {
        throw new BadRequestException({
          code: 'WORKSHOP_ACTIVATION_REQUIREMENTS_NOT_MET',
          message: 'No se puede activar un taller sin dirección, referencia local, ubicación y municipio.',
          details: {},
        });
      }
      const location = await this.prisma.$queryRaw<Array<{ has_location: boolean }>>(Prisma.sql`
        SELECT location IS NOT NULL AS has_location FROM public.workshops WHERE id = ${id}::uuid
      `);
      if (!location[0]?.has_location) throw new BadRequestException({
        code: 'WORKSHOP_LOCATION_REQUIRED',
        message: 'No se puede activar un taller sin ubicación geográfica.',
        details: {},
      });
    }
    const updated = await this.prisma.workshop.update({
      where: { id }, data: { status, ...(status === 'active' ? { verifiedAt: new Date() } : {}) },
      select: { id: true, status: true, verifiedAt: true, updatedAt: true },
    });
    await this.invalidateDirectoryCache();
    return updated;
  }

  async getPublicDetail(slug: string): Promise<Record<string, unknown>> {
    const record = await this.prisma.workshop.findFirst({
      where: { slug, status: 'active', deletedAt: null },
      include: {
        department: { select: { id: true, name: true } },
        municipality: { select: { id: true, name: true } },
        specialties: { where: { deletedAt: null, specialty: { isActive: true } }, include: { specialty: { select: { id: true, name: true } } } },
        photos: { where: { deletedAt: null, status: 'published' }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], take: 12, select: { id: true, altText: true, sortOrder: true, objectKey: true } },
        serviceOfferings: { where: { deletedAt: null, isActive: true, publicationStatus: 'published' }, include: { serviceType: { select: { id: true, name: true } } }, orderBy: [{ name: 'asc' }], take: 50 },
      },
    });
    if (!record) throw this.workshopNotFound();
    const hasPrices = record.serviceOfferings.length > 0;
    const photos = await Promise.all(record.photos.map(async (photo) => {
      const signed = await this.storage.createDownloadUrl(photo.objectKey);
      return { id: photo.id, alt_text: photo.altText, sort_order: photo.sortOrder, url: signed.url };
    }));
    return {
      id: record.id,
      slug: record.slug,
      name: record.name,
      description: record.description,
      address: record.address,
      address_reference_text: record.addressReferenceText,
      department: record.department,
      municipality: record.municipality,
      weekly_schedule: record.weeklySchedule,
      is_open_now: this.isOpenNow(record.weeklySchedule as Record<string, unknown>),
      rating_average: Number(record.ratingAverage),
      rating_count: record.ratingCount,
      contact_available: { call: Boolean(record.phoneCiphertext), whatsapp: Boolean(record.whatsappCiphertext), email: Boolean(record.emailCiphertext) },
      specialties: record.specialties.map((item) => item.specialty),
      photos,
      service_offerings: record.serviceOfferings.map((item) => this.serializeOffering(item)),
      ...(hasPrices ? { pricing_disclaimer: PRICE_DISCLAIMER } : {}),
      fetched_at: new Date().toISOString(),
    };
  }

  async getPublicContactDetails(slug: string): Promise<Record<string, unknown>> {
    const record = await this.prisma.workshop.findFirst({ where: { slug, status: 'active', deletedAt: null } });
    if (!record) throw this.workshopNotFound();
    const [phone, whatsapp, email] = await Promise.all([
      this.decryptContact(record, 'phone'),
      this.decryptContact(record, 'whatsapp'),
      this.decryptContact(record, 'email'),
    ]);
    return { phone, whatsapp, email };
  }

  async search(query: SearchWorkshopsQueryDto): Promise<Record<string, unknown>> {
    if ((query.lat === undefined) !== (query.lng === undefined)) {
      throw new BadRequestException({ code: 'COORDINATES_PAIR_REQUIRED', message: 'Envía lat y lng juntos.', details: {} });
    }
    const normalizedQuery = { ...query, q: query.q?.trim() || undefined };
    let cacheVersion = 'uncached';
    let cacheKey: string | null = null;
    try {
      cacheVersion = (await this.redis.client.get('directory:workshops:version')) ?? '0';
      cacheKey = `directory:workshops:${cacheVersion}:${createHash('sha256').update(JSON.stringify(normalizedQuery)).digest('hex')}`;
      const cached = await this.redis.client.get(cacheKey);
      if (cached) return JSON.parse(cached) as Record<string, unknown>;
    } catch (error) {
      cacheKey = null;
      this.logger.warn(`Cache de talleres no disponible; se consultará PostgreSQL. ${error instanceof Error ? error.message : ''}`);
    }

    const where: Prisma.Sql[] = [Prisma.sql`w.status = 'active'::public.workshop_status`, Prisma.sql`w.deleted_at IS NULL`];
    const hasPoint = query.lat !== undefined && query.lng !== undefined;
    const point = hasPoint
      ? Prisma.sql`ST_SetSRID(ST_MakePoint(${query.lng!}, ${query.lat!}), 4326)::geography`
      : Prisma.sql`NULL::geography`;
    if (hasPoint) where.push(Prisma.sql`w.location IS NOT NULL AND ST_DWithin(w.location, ${point}, ${query.radius_meters})`);
    if (query.municipality_id) where.push(Prisma.sql`w.municipality_id = ${query.municipality_id}::uuid`);
    if (query.specialty_id) where.push(Prisma.sql`EXISTS (
      SELECT 1 FROM public.workshop_specialties ws
      WHERE ws.workshop_id = w.id AND ws.specialty_id = ${query.specialty_id}::uuid AND ws.deleted_at IS NULL
    )`);
    if (normalizedQuery.q) where.push(Prisma.sql`w.search_document @@ plainto_tsquery('simple', ${normalizedQuery.q})`);
    if (query.open_now) where.push(Prisma.sql`public.workshop_is_open_now(w.weekly_schedule, clock_timestamp())`);

    // Hook B9: actualmente FALSE. B9 reemplazará este literal por la existencia
    // de una campaña activa, aprobada y pagada, sin alterar las puntuaciones.
    const distanceSelect = hasPoint ? Prisma.sql`ST_Distance(w.location, ${point})` : Prisma.sql`NULL::double precision`;
    const rows = await this.prisma.$queryRaw<WorkshopSearchRow[]>(Prisma.sql`
      SELECT w.id, w.slug,
        CASE WHEN w.location IS NULL THEN NULL ELSE ST_Y(w.location::geometry) END AS latitude,
        CASE WHEN w.location IS NULL THEN NULL ELSE ST_X(w.location::geometry) END AS longitude,
        ${distanceSelect} AS distance_meters,
        public.workshop_is_open_now(w.weekly_schedule, clock_timestamp()) AS is_open_now,
        FALSE AS sponsored
      FROM public.workshops w
      WHERE ${Prisma.join(where, ' AND ')}
      ORDER BY sponsored DESC,
        distance_meters ASC NULLS LAST,
        w.rating_average DESC,
        w.rating_count DESC,
        w.id ASC
      LIMIT ${query.limit}
    `);
    const records = rows.length ? await this.prisma.workshop.findMany({
      where: { id: { in: rows.map((row) => row.id) }, status: 'active', deletedAt: null },
      include: {
        department: { select: { id: true, name: true } },
        municipality: { select: { id: true, name: true } },
        specialties: { where: { deletedAt: null, specialty: { isActive: true } }, include: { specialty: { select: { id: true, name: true } } } },
        photos: { where: { deletedAt: null, status: 'published' }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], take: 1, select: { id: true, altText: true } },
        serviceOfferings: { where: { deletedAt: null, isActive: true, publicationStatus: 'published' }, include: { serviceType: { select: { id: true, name: true } } }, orderBy: [{ name: 'asc' }], take: 5 },
      },
    }) : [];
    const byId = new Map(records.map((record) => [record.id, record]));
    const items = rows.flatMap((row) => {
      const record = byId.get(row.id);
      if (!record) return [];
      return [{
        id: record.id,
        slug: record.slug,
        name: record.name,
        description: record.description,
        address: record.address,
        address_reference_text: record.addressReferenceText,
        department: record.department,
        municipality: record.municipality,
        latitude: row.latitude,
        longitude: row.longitude,
        distance_meters: row.distance_meters === null ? null : Math.round(Number(row.distance_meters)),
        rating_average: Number(record.ratingAverage),
        rating_count: record.ratingCount,
        is_open_now: row.is_open_now,
        weekly_schedule: record.weeklySchedule,
        sponsored: row.sponsored,
        contact_available: { call: Boolean(record.phoneCiphertext), whatsapp: Boolean(record.whatsappCiphertext) },
        specialties: record.specialties.map((item) => item.specialty),
        photos: record.photos,
        service_offerings: record.serviceOfferings.map((item) => this.serializeOffering(item)),
      }];
    });
    const hasPrices = items.some((item) => Array.isArray(item.service_offerings) && item.service_offerings.length > 0);
    const fetchedAt = new Date().toISOString();
    const response: Record<string, unknown> = {
      items,
      count: items.length,
      fetched_at: fetchedAt,
      cache_ttl_seconds: OFFLINE_CACHE_TTL_SECONDS,
      max_cache_records: 50,
      timezone: 'America/Managua',
      open_now_calculated_at: fetchedAt,
      ...(hasPrices ? { pricing_disclaimer: PRICE_DISCLAIMER } : {}),
    };
    if (cacheKey) {
      try {
        await this.redis.client.set(cacheKey, JSON.stringify(response), 'EX', DIRECTORY_CACHE_TTL_SECONDS);
      } catch (error) {
        this.logger.warn(`No se pudo guardar el caché de talleres. ${error instanceof Error ? error.message : ''}`);
      }
    }
    return response;
  }

  async createContactEvent(slug: string, eventType: 'call' | 'whatsapp' | 'route_click'): Promise<Record<string, unknown>> {
    const workshop = await this.prisma.workshop.findFirst({
      where: { slug, status: 'active', deletedAt: null },
      select: { id: true },
    });
    if (!workshop) throw this.workshopNotFound();
    const event = await this.prisma.workshopContactEvent.create({
      data: { workshopId: workshop.id, eventType },
      select: { id: true, eventType: true, createdAt: true },
    });
    return { accepted: true, event_type: event.eventType, recorded_at: event.createdAt };
  }

  async replaceSpecialties(userId: string, workshopId: string, specialtyIds: string[]): Promise<Record<string, unknown>> {
    const workshop = await this.prisma.workshop.findFirst({ where: { id: workshopId, userId, deletedAt: null }, select: { id: true } });
    if (!workshop) throw this.workshopNotFound();
    const specialties = await this.prisma.specialty.findMany({ where: { id: { in: specialtyIds }, isActive: true }, select: { id: true } });
    if (specialties.length !== specialtyIds.length) throw new BadRequestException({
      code: 'SPECIALTY_INVALID', message: 'Una o más especialidades no existen o están inactivas.', details: {},
    });
    await this.prisma.$transaction(async (tx) => {
      await tx.workshopSpecialty.updateMany({ where: { workshopId, userId, deletedAt: null }, data: { deletedAt: new Date() } });
      if (specialtyIds.length) {
        await tx.workshopSpecialty.createMany({
          data: specialtyIds.map((specialtyId) => ({ id: generateUuidV7(), userId, workshopId, specialtyId })),
        });
      }
    });
    await this.invalidateDirectoryCache();
    return { workshop_id: workshopId, specialty_ids: specialtyIds };
  }

  async createPhotoUpload(userId: string, workshopId: string, dto: WorkshopPhotoUploadDto): Promise<Record<string, unknown>> {
    if (!ALLOWED_PHOTO_TYPES.has(dto.content_type)) throw new BadRequestException({ code: 'PHOTO_TYPE_INVALID', message: 'El tipo de imagen no está permitido.', details: {} });
    if (dto.size_bytes > MAX_PHOTO_BYTES) throw new PayloadTooLargeException({ code: 'PHOTO_TOO_LARGE', message: 'La imagen supera el máximo de 10 MiB.', details: {} });
    const workshop = await this.prisma.workshop.findFirst({ where: { id: workshopId, userId, deletedAt: null }, select: { id: true } });
    if (!workshop) throw this.workshopNotFound();
    const photoId = generateUuidV7();
    const objectKey = `workshops/${workshopId}/photos/${randomUUID()}`;
    const signed = await this.storage.createUploadUrl(objectKey, dto.content_type, dto.size_bytes);
    const photo = await this.prisma.workshopPhoto.create({
      data: { id: photoId, userId, workshopId, objectKey, mimeType: dto.content_type, sizeBytes: BigInt(dto.size_bytes), altText: dto.alt_text ?? null },
      select: { id: true, status: true },
    });
    return { photo_id: photo.id, status: photo.status, upload_url: signed.url, expires_in_seconds: signed.expiresInSeconds, required_headers: signed.requiredHeaders, simulated: signed.simulated };
  }

  async confirmPhotoUpload(userId: string, photoId: string): Promise<Record<string, unknown>> {
    const photo = await this.prisma.workshopPhoto.findFirst({ where: { id: photoId, userId, deletedAt: null } });
    if (!photo) throw new NotFoundException({ code: 'WORKSHOP_PHOTO_NOT_FOUND', message: 'No se encontró la fotografía.', details: {} });
    const metadata = await this.storage.headObject(photo.objectKey);
    if (!metadata.contentLength || !metadata.contentType) throw new ConflictException({
      code: 'PHOTO_STORAGE_VERIFICATION_REQUIRED',
      message: 'El almacenamiento todavía no confirma el tamaño y el tipo real de la imagen. No se publicará hasta verificar el archivo.',
      details: {},
    });
    if (metadata.contentLength !== Number(photo.sizeBytes) || metadata.contentType !== photo.mimeType) throw new ConflictException({
      code: 'PHOTO_METADATA_MISMATCH', message: 'El archivo cargado no coincide con los metadatos declarados.', details: {},
    });
    const signature = await this.storage.getObjectPrefix(photo.objectKey, 12);
    if (!signature || !this.matchesPhotoSignature(photo.mimeType, signature)) throw new ConflictException({
      code: 'PHOTO_CONTENT_INVALID', message: 'El contenido real no corresponde al tipo de imagen declarado.', details: {},
    });
    const updated = await this.prisma.workshopPhoto.update({
      where: { id: photoId }, data: { status: 'published' }, select: { id: true, status: true, updatedAt: true },
    });
    await this.invalidateDirectoryCache();
    return updated;
  }

  async createServiceOffering(userId: string, dto: CreateServiceOfferingDto): Promise<Record<string, unknown>> {
    if (dto.price_max < dto.price_min) throw new BadRequestException({ code: 'PRICE_RANGE_INVALID', message: 'price_max debe ser mayor o igual que price_min.', details: {} });
    const owner = await this.resolveOfferingOwner(userId, dto.owner_type, dto.owner_id);
    const serviceType = await this.prisma.serviceType.findFirst({ where: { id: dto.service_type_id, isActive: true }, select: { id: true } });
    if (!serviceType) throw new BadRequestException({ code: 'SERVICE_TYPE_INVALID', message: 'El tipo de servicio no existe o está inactivo.', details: {} });
    const offering = await this.prisma.serviceOffering.create({
      data: {
        id: dto.id,
        userId,
        workshopId: dto.owner_type === 'workshop' ? owner.id : null,
        assistanceProviderId: dto.owner_type === 'assistance_provider' ? owner.id : null,
        serviceTypeId: dto.service_type_id,
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        priceMin: dto.price_min,
        priceMax: dto.price_max,
        currency: 'USD',
        unit: dto.unit.trim(),
        notes: dto.notes?.trim() || null,
      },
      select: { id: true, name: true, publicationStatus: true, lastUpdatedAt: true },
    });
    await this.invalidateDirectoryCache();
    return offering;
  }

  async updateServiceOffering(userId: string, id: string, dto: UpdateServiceOfferingDto): Promise<Record<string, unknown>> {
    const existing = await this.prisma.serviceOffering.findFirst({ where: { id, userId, deletedAt: null } });
    if (!existing) throw new NotFoundException({ code: 'SERVICE_OFFERING_NOT_FOUND', message: 'No se encontró la oferta de servicio.', details: {} });
    const priceMin = dto.price_min ?? Number(existing.priceMin);
    const priceMax = dto.price_max ?? Number(existing.priceMax);
    if (priceMax < priceMin) throw new BadRequestException({ code: 'PRICE_RANGE_INVALID', message: 'price_max debe ser mayor o igual que price_min.', details: {} });
    if (dto.publication_status === 'published') {
      if (existing.workshopId) {
        const workshop = await this.prisma.workshop.findFirst({ where: { id: existing.workshopId, userId, status: 'active', deletedAt: null }, select: { id: true } });
        if (!workshop) throw new ConflictException({ code: 'OFFERING_OWNER_NOT_PUBLIC', message: 'La oferta solo puede publicarse cuando el taller está activo.', details: {} });
      } else if (existing.assistanceProviderId) {
        const provider = await this.prisma.assistanceProvider.findFirst({ where: { id: existing.assistanceProviderId, userId, status: 'active', deletedAt: null }, select: { id: true } });
        if (!provider) throw new ConflictException({ code: 'OFFERING_OWNER_NOT_PUBLIC', message: 'La oferta solo puede publicarse cuando el proveedor está activo.', details: {} });
      }
    }
    const data: Prisma.ServiceOfferingUncheckedUpdateInput = {
      ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
      ...(dto.description !== undefined ? { description: dto.description?.trim() || null } : {}),
      ...(dto.price_min !== undefined ? { priceMin: dto.price_min } : {}),
      ...(dto.price_max !== undefined ? { priceMax: dto.price_max } : {}),
      ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
      ...(dto.unit !== undefined ? { unit: dto.unit.trim() } : {}),
      ...(dto.notes !== undefined ? { notes: dto.notes?.trim() || null } : {}),
      ...(dto.is_active !== undefined ? { isActive: dto.is_active } : {}),
      ...(dto.publication_status !== undefined ? { publicationStatus: dto.publication_status } : {}),
    };
    const updated = await this.prisma.serviceOffering.update({ where: { id }, data, select: { id: true, name: true, publicationStatus: true, lastUpdatedAt: true } });
    await this.invalidateDirectoryCache();
    return updated;
  }

  async deleteServiceOffering(userId: string, id: string): Promise<Record<string, unknown>> {
    const existing = await this.prisma.serviceOffering.findFirst({ where: { id, userId, deletedAt: null }, select: { id: true } });
    if (!existing) throw new NotFoundException({ code: 'SERVICE_OFFERING_NOT_FOUND', message: 'No se encontró la oferta de servicio.', details: {} });
    const deleted = await this.prisma.serviceOffering.update({ where: { id }, data: { deletedAt: new Date(), publicationStatus: 'suspended' }, select: { id: true, deletedAt: true } });
    await this.invalidateDirectoryCache();
    return { id: deleted.id, status: 'deleted', deleted_at: deleted.deletedAt };
  }

  private serializeOffering(offering: {
    id: string; name: string; description: string | null; priceMin: Prisma.Decimal; priceMax: Prisma.Decimal;
    currency: string; unit: string; notes: string | null; lastUpdatedAt: Date; serviceType?: { id: string; name: string };
  }): Record<string, unknown> {
    const isStale = Date.now() - offering.lastUpdatedAt.getTime() > STALE_PRICE_AFTER_DAYS * 24 * 60 * 60 * 1000;
    return {
      id: offering.id,
      name: offering.name,
      description: offering.description,
      service_type: offering.serviceType ?? undefined,
      price_min: Number(offering.priceMin),
      price_max: Number(offering.priceMax),
      currency: offering.currency.trim(),
      unit: offering.unit,
      notes: offering.notes,
      last_updated_at: offering.lastUpdatedAt,
      price_status: isStale ? 'desactualizado' : 'actualizado',
      price_disclaimer: PRICE_DISCLAIMER,
    };
  }

  private async resolveOfferingOwner(userId: string, ownerType: 'workshop' | 'assistance_provider', ownerId: string): Promise<{ id: string }> {
    if (ownerType === 'workshop') {
      const workshop = await this.prisma.workshop.findFirst({ where: { id: ownerId, userId, deletedAt: null }, select: { id: true } });
      if (!workshop) throw this.workshopNotFound();
      return workshop;
    }
    const provider = await this.prisma.assistanceProvider.findFirst({ where: { id: ownerId, userId, deletedAt: null }, select: { id: true } });
    if (!provider) throw new NotFoundException({ code: 'ASSISTANCE_PROVIDER_NOT_FOUND', message: 'No se encontró el proveedor propio.', details: {} });
    return provider;
  }

  private async uniqueSlug(name: string, id: string): Promise<string> {
    const base = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 150) || 'taller';
    const candidate = `${base}-${id.slice(0, 8)}`;
    const existing = await this.prisma.workshop.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!existing) return candidate;
    return `${base}-${randomUUID().slice(0, 8)}`;
  }

  private async encryptContacts(userId: string, recordId: string, dto: Pick<CreateWorkshopDto, 'phone' | 'whatsapp' | 'email'> | Pick<UpdateWorkshopDto, 'phone' | 'whatsapp' | 'email'>, onlyProvided = false): Promise<ContactCipherColumns> {
    const output: ContactCipherColumns = {};
    const fields = [
      { key: 'phone', prefix: 'phone', purpose: 'workshops.phone' },
      { key: 'whatsapp', prefix: 'whatsapp', purpose: 'workshops.whatsapp' },
      { key: 'email', prefix: 'email', purpose: 'workshops.email' },
    ] as const;
    for (const field of fields) {
      const value = dto[field.key];
      if (onlyProvided && value === undefined) continue;
      if (value === undefined || value === null || value === '') {
        Object.assign(output, this.emptyContactColumns(field.prefix));
        continue;
      }
      const encrypted = await this.crypto.encrypt(value.trim(), field.purpose, { userId, recordId });
      Object.assign(output, this.mapEncryptedContact(field.prefix, encrypted));
    }
    return output;
  }

  private emptyContactColumns(prefix: 'phone' | 'whatsapp' | 'email'): Record<string, null> {
    return {
      [`${prefix}Ciphertext`]: null,
      [`${prefix}Nonce`]: null,
      [`${prefix}Tag`]: null,
      [`${prefix}EncryptedDek`]: null,
      [`${prefix}KeyVersion`]: null,
      [`${prefix}AadVersion`]: null,
    };
  }

  private mapEncryptedContact(prefix: 'phone' | 'whatsapp' | 'email', encrypted: EncryptedField): Record<string, Buffer | string | number> {
    return {
      [`${prefix}Ciphertext`]: encrypted.ciphertext,
      [`${prefix}Nonce`]: encrypted.nonce,
      [`${prefix}Tag`]: encrypted.tag,
      [`${prefix}EncryptedDek`]: encrypted.encryptedDek,
      [`${prefix}KeyVersion`]: encrypted.keyVersion,
      [`${prefix}AadVersion`]: encrypted.aadVersion ?? 2,
    };
  }

  private async decryptContact(record: WorkshopContactRecord, prefix: 'phone' | 'whatsapp' | 'email'): Promise<string | null> {
    const field = prefix === 'phone'
      ? { ciphertext: record.phoneCiphertext, nonce: record.phoneNonce, tag: record.phoneTag, encryptedDek: record.phoneEncryptedDek, keyVersion: record.phoneKeyVersion, aadVersion: record.phoneAadVersion }
      : prefix === 'whatsapp'
        ? { ciphertext: record.whatsappCiphertext, nonce: record.whatsappNonce, tag: record.whatsappTag, encryptedDek: record.whatsappEncryptedDek, keyVersion: record.whatsappKeyVersion, aadVersion: record.whatsappAadVersion }
        : { ciphertext: record.emailCiphertext, nonce: record.emailNonce, tag: record.emailTag, encryptedDek: record.emailEncryptedDek, keyVersion: record.emailKeyVersion, aadVersion: record.emailAadVersion };
    if (!field.ciphertext) return null;
    if (!field.nonce || !field.tag || !field.encryptedDek || !field.keyVersion) {
      throw new ConflictException({ code: 'WORKSHOP_CONTACT_METADATA_INVALID', message: 'Los datos de contacto protegidos están incompletos.', details: {} });
    }
    return this.crypto.decrypt({
      ciphertext: Buffer.from(field.ciphertext),
      nonce: Buffer.from(field.nonce),
      tag: Buffer.from(field.tag),
      encryptedDek: Buffer.from(field.encryptedDek),
      keyVersion: field.keyVersion,
      aadVersion: field.aadVersion ?? 2,
    }, `workshops.${prefix}`, { userId: record.userId, recordId: record.id });
  }

  private async assertMunicipality(departmentId: string | null, municipalityId: string | null): Promise<void> {
    if (!departmentId && !municipalityId) return;
    if (!departmentId || !municipalityId) throw new BadRequestException({
      code: 'WORKSHOP_MUNICIPALITY_DEPARTMENT_REQUIRED', message: 'Departamento y municipio deben enviarse juntos.', details: {},
    });
    const municipality = await this.prisma.municipality.findFirst({ where: { id: municipalityId, departmentId, isActive: true }, select: { id: true } });
    if (!municipality) throw new BadRequestException({ code: 'MUNICIPALITY_DEPARTMENT_MISMATCH', message: 'El municipio no pertenece al departamento indicado o está inactivo.', details: {} });
  }

  private assertCoordinatePair(latitude?: number, longitude?: number): void {
    if ((latitude === undefined) !== (longitude === undefined)) throw new BadRequestException({
      code: 'COORDINATES_PAIR_REQUIRED', message: 'Latitud y longitud deben enviarse juntas.', details: {},
    });
  }

  private validateWeeklySchedule(schedule: Record<string, unknown>): void {
    const unknownDays = Object.keys(schedule).filter((day) => !(WEEK_DAYS as readonly string[]).includes(day));
    if (unknownDays.length) throw new BadRequestException({ code: 'WEEKLY_SCHEDULE_INVALID', message: 'El horario contiene días no válidos.', details: { days: unknownDays } });
    for (const day of WEEK_DAYS) {
      const periods = schedule[day];
      if (periods === undefined) continue;
      if (!Array.isArray(periods) || periods.length > 4) throw new BadRequestException({ code: 'WEEKLY_SCHEDULE_INVALID', message: `El horario de ${day} debe ser un arreglo de hasta cuatro intervalos.`, details: {} });
      const segments: Array<{ start: number; end: number }> = [];
      let fullDay = false;
      for (const period of periods) {
        if (typeof period !== 'object' || period === null || Array.isArray(period)) throw new BadRequestException({ code: 'WEEKLY_SCHEDULE_INVALID', message: `El intervalo de ${day} no es válido.`, details: {} });
        const value = period as Record<string, unknown>;
        if (typeof value.open !== 'string' || typeof value.close !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.open) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.close)) {
          throw new BadRequestException({ code: 'WEEKLY_SCHEDULE_INVALID', message: `Los horarios de ${day} deben usar HH:MM de 24 horas.`, details: {} });
        }
        const start = this.timeMinutes(value.open);
        const end = this.timeMinutes(value.close);
        if (start === end) { fullDay = true; continue; }
        if (start < end) segments.push({ start, end });
        else {
          segments.push({ start, end: 1440 });
          segments.push({ start: 0, end });
        }
      }
      segments.sort((a, b) => a.start - b.start);
      if (fullDay && (periods.length > 1 || segments.length > 0)) throw new BadRequestException({ code: 'WEEKLY_SCHEDULE_OVERLAP', message: `El horario de ${day} cubre todo el día y no admite otros intervalos.`, details: {} });
      for (let index = 1; index < segments.length; index += 1) {
        if (segments[index].start < segments[index - 1].end) throw new BadRequestException({ code: 'WEEKLY_SCHEDULE_OVERLAP', message: `Los intervalos de ${day} se superponen, incluso al cruzar medianoche.`, details: {} });
      }
    }
  }

  private isOpenNow(schedule: Record<string, unknown>): boolean {
    const localParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Managua', weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date());
    const parts = Object.fromEntries(localParts.map((part) => [part.type, part.value]));
    const dayName = String(parts.weekday).toLowerCase();
    const currentMinutes = Number(parts.hour) * 60 + Number(parts.minute);
    const dayIndex = WEEK_DAYS.indexOf(dayName as typeof WEEK_DAYS[number]);
    const previousIndex = (dayIndex + 6) % 7;
    const intervals = (day: string): Array<{ open: string; close: string }> => Array.isArray(schedule[day])
      ? (schedule[day] as Array<{ open: string; close: string }>).filter((period) => typeof period?.open === 'string' && typeof period?.close === 'string')
      : [];
    for (const period of intervals(dayName)) {
      const open = this.timeMinutes(period.open);
      const close = this.timeMinutes(period.close);
      if (open === close || (open < close && currentMinutes >= open && currentMinutes < close) || (open > close && currentMinutes >= open)) return true;
    }
    const previousDay = WEEK_DAYS[previousIndex];
    return intervals(previousDay).some((period) => {
      const open = this.timeMinutes(period.open);
      const close = this.timeMinutes(period.close);
      return open > close && currentMinutes < close;
    });
  }

  private timeMinutes(value: string): number {
    const [hour, minute] = value.split(':').map(Number);
    return hour * 60 + minute;
  }

  private matchesPhotoSignature(contentType: string, bytes: Buffer): boolean {
    if (contentType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (contentType === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (contentType === 'image/webp') return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    return false;
  }

  private async invalidateDirectoryCache(): Promise<void> {
    try {
      // Cache versionado: invalidación O(1), sin Redis KEYS ni borrado de grandes conjuntos.
      await this.redis.client.incr('directory:workshops:version');
    } catch (error) {
      this.logger.warn(`No se pudo invalidar el caché de talleres. ${error instanceof Error ? error.message : ''}`);
    }
  }

  private idCollision() {
    return new ConflictException({ code: 'ID_COLLISION', message: 'El identificador solicitado ya está en uso.', details: {} });
  }

  private workshopNotFound() {
    return new NotFoundException({ code: 'WORKSHOP_NOT_FOUND', message: 'No se encontró un taller disponible.', details: {} });
  }
}
