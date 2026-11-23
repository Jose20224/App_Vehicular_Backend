import { prismaBytes } from "../../database/prisma-bytes";
import {
  BadRequestException, ConflictException, GoneException,
  Injectable, NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { AppConfigService } from '../../config/config.module';
import { PrismaService } from '../../database/prisma.service';
import { FieldCryptoService } from '../../security/field-crypto.service';
import { RedisService } from '../../redis/redis.service';
import { AssistanceRateLimitService } from './assistance-rate-limit.service';
import { AssistanceQueueService } from './assistance-queue.service';
import type { CreateAssistanceProviderDto } from './dto/create-assistance-provider.dto';
import type { UpdateAssistanceProviderDto } from './dto/update-assistance-provider.dto';
import type { SearchAssistanceProvidersQueryDto } from './dto/search-assistance-providers-query.dto';
import type { CreateAssistanceRequestDto } from './dto/create-assistance-request.dto';
import type { AssistanceHistoryQueryDto } from './dto/history-query.dto';
import type { AssistanceNotificationAdapter } from './assistance-notification.adapter';
import { ASSISTANCE_NOTIFICATION_ADAPTER } from './assistance-notification.adapter';
import { Inject } from '@nestjs/common';

const PRICE_DISCLAIMER = 'Precio estimado. El pago se realiza directamente al taller o al proveedor cuando se presta el servicio.';
const OFFLINE_PACKAGE_TTL_SECONDS = 7 * 24 * 60 * 60;
const OFFLINE_PACKAGE_MAX_BYTES = 99_999;
const STALE_PRICE_AFTER_DAYS = 90;


type ProviderSearchRow = {
  id: string; distance_meters: number; latitude: number | null; longitude: number | null;
  price_min: string | null; price_max: string | null; price_updated_at: Date | null;
  service_name: string; department_name: string | null; municipality_name: string | null;
};
type ContactColumns = {
  id: string; userId: string; phoneCiphertext: Uint8Array | null; phoneNonce: Uint8Array | null;
  phoneTag: Uint8Array | null; phoneEncryptedDek: Uint8Array | null; phoneKeyVersion: string | null;
  phoneAadVersion: number | null; whatsappCiphertext: Uint8Array | null; whatsappNonce: Uint8Array | null;
  whatsappTag: Uint8Array | null; whatsappEncryptedDek: Uint8Array | null; whatsappKeyVersion: string | null;
  whatsappAadVersion: number | null;
};
const ASSISTANCE_REQUEST_HISTORY_INCLUDE = {
  assistanceProvider: { select: { id: true, name: true, providerType: true } },
  serviceType: { select: { id: true, name: true } },
  vehicle: { select: { id: true, brandLabel: true, modelLabel: true, modelYear: true, vehicleType: true } },
  events: { orderBy: { createdAt: 'asc' }, select: { fromStatus: true, toStatus: true, actorType: true, createdAt: true } },
} as const;
type AssistanceRequestHistoryRow = Prisma.AssistanceRequestGetPayload<{
  include: typeof ASSISTANCE_REQUEST_HISTORY_INCLUDE;
}>;

@Injectable()
export class ProvidersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: FieldCryptoService,
    private readonly redis: RedisService,
    private readonly config: AppConfigService,
    private readonly rateLimit: AssistanceRateLimitService,
    private readonly queue: AssistanceQueueService,
    @Inject(ASSISTANCE_NOTIFICATION_ADAPTER) private readonly notifier: AssistanceNotificationAdapter,
  ) {}

  async createProvider(userId: string, dto: CreateAssistanceProviderDto): Promise<Record<string, unknown>> {
    this.assertCoordinatePair(dto.latitude, dto.longitude);
    this.validateCoverageGeoJson(dto.coverage_geojson);
    await this.assertTerritory(dto.department_id ?? null, dto.municipality_id ?? null);
    const serviceType = await this.prisma.serviceType.findFirst({ where: { id: dto.service_type_id, isActive: true }, select: { id: true } });
    if (!serviceType) throw new BadRequestException({ code: 'SERVICE_TYPE_INVALID', message: 'El tipo de servicio no existe o está inactivo.', details: {} });

    const existing = await this.prisma.assistanceProvider.findUnique({ where: { id: dto.id }, select: { id: true, userId: true, name: true, status: true, deletedAt: true } });
    if (existing) {
      if (existing.userId !== userId || existing.deletedAt || existing.name !== dto.name.trim()) throw new ConflictException({
        code: 'ASSISTANCE_PROVIDER_ID_CONFLICT', message: 'El identificador del proveedor ya está utilizado.', details: {},
      });
      return { id: existing.id, status: existing.status, idempotent_replay: true };
    }

    const [phone, phoneIndex, whatsapp] = await Promise.all([
      this.encryptContact(dto.phone_e164, 'phone', userId, dto.id),
      this.crypto.blindIndex(dto.phone_e164, 'assistance_providers.phone'),
      dto.whatsapp_e164 ? this.encryptContact(dto.whatsapp_e164, 'whatsapp', userId, dto.id) : Promise.resolve(null),
    ]);
    const whatsappIndex = dto.whatsapp_e164 ? await this.crypto.blindIndex(dto.whatsapp_e164, 'assistance_providers.whatsapp') : null;

    await this.prisma.$transaction(async (tx) => {
      await tx.assistanceProvider.create({ data: {
        id: dto.id, userId, name: dto.name.trim(), providerType: dto.provider_type.trim(), serviceTypeId: dto.service_type_id,
        description: dto.description?.trim() || null, addressReferenceText: dto.address_reference_text.trim(),
        departmentId: dto.department_id ?? null, municipalityId: dto.municipality_id ?? null,
        is24Hours: dto.is_24_hours ?? false, availabilityStatus: dto.availability_status ?? 'available',
        phoneCiphertext: prismaBytes(phone.ciphertext), phoneNonce: prismaBytes(phone.nonce), phoneTag: prismaBytes(phone.tag),
        phoneEncryptedDek: prismaBytes(phone.encryptedDek), phoneKeyVersion: phone.keyVersion, phoneAadVersion: phone.aadVersion ?? 2,
        phoneHmac: prismaBytes(phoneIndex.digest), phoneHmacKeyVersion: phoneIndex.keyVersion,
        ...(whatsapp ? {
          whatsappCiphertext: prismaBytes(whatsapp.ciphertext), whatsappNonce: prismaBytes(whatsapp.nonce), whatsappTag: prismaBytes(whatsapp.tag),
          whatsappEncryptedDek: prismaBytes(whatsapp.encryptedDek), whatsappKeyVersion: whatsapp.keyVersion,
          whatsappAadVersion: whatsapp.aadVersion ?? 2, whatsappHmac: whatsappIndex ? prismaBytes(whatsappIndex.digest) : undefined,
          whatsappHmacKeyVersion: whatsappIndex?.keyVersion,
        } : {}),
      } });
      await tx.$executeRaw(Prisma.sql`
        UPDATE public.assistance_providers
        SET base_location = ST_SetSRID(ST_MakePoint(${dto.longitude}, ${dto.latitude}), 4326)::geography,
            coverage_area = ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(dto.coverage_geojson)}), 4326))
        WHERE id = ${dto.id}::uuid AND user_id = ${userId}::uuid
      `);
      await this.assertCoverageValid(tx, dto.id);
    });
    return { id: dto.id, status: 'draft', idempotent_replay: false };
  }

  async updateProvider(userId: string, id: string, dto: UpdateAssistanceProviderDto): Promise<Record<string, unknown>> {
    const existing = await this.prisma.assistanceProvider.findFirst({ where: { id, userId, deletedAt: null } });
    if (!existing) throw this.providerNotFound();
    const latitudePresent = dto.latitude !== undefined;
    const longitudePresent = dto.longitude !== undefined;
    if (latitudePresent !== longitudePresent) throw new BadRequestException({ code: 'COORDINATE_PAIR_REQUIRED', message: 'latitude y longitude deben actualizarse juntas.', details: {} });
    if (dto.coverage_geojson !== undefined) this.validateCoverageGeoJson(dto.coverage_geojson);
    const departmentId = dto.department_id !== undefined ? dto.department_id : existing.departmentId;
    const municipalityId = dto.municipality_id !== undefined ? dto.municipality_id : existing.municipalityId;
    await this.assertTerritory(departmentId, municipalityId);

    const data: Prisma.AssistanceProviderUncheckedUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.provider_type !== undefined) data.providerType = dto.provider_type.trim();
    if (dto.service_type_id !== undefined) {
      const type = await this.prisma.serviceType.findFirst({ where: { id: dto.service_type_id, isActive: true }, select: { id: true } });
      if (!type) throw new BadRequestException({ code: 'SERVICE_TYPE_INVALID', message: 'El tipo de servicio no existe o está inactivo.', details: {} });
      data.serviceTypeId = dto.service_type_id;
    }
    if (dto.description !== undefined) data.description = dto.description?.trim() || null;
    if (dto.address_reference_text !== undefined) data.addressReferenceText = dto.address_reference_text.trim();
    if (dto.department_id !== undefined) data.departmentId = dto.department_id;
    if (dto.municipality_id !== undefined) data.municipalityId = dto.municipality_id;
    if (dto.is_24_hours !== undefined) data.is24Hours = dto.is_24_hours;
    if (dto.availability_status !== undefined) data.availabilityStatus = dto.availability_status;

    if (dto.phone_e164 !== undefined) {
      const [encrypted, index] = await Promise.all([
        this.encryptContact(dto.phone_e164, 'phone', userId, id), this.crypto.blindIndex(dto.phone_e164, 'assistance_providers.phone'),
      ]);
      Object.assign(data, { phoneCiphertext: prismaBytes(encrypted.ciphertext), phoneNonce: prismaBytes(encrypted.nonce), phoneTag: prismaBytes(encrypted.tag),
        phoneEncryptedDek: prismaBytes(encrypted.encryptedDek), phoneKeyVersion: encrypted.keyVersion, phoneAadVersion: encrypted.aadVersion ?? 2,
        phoneHmac: prismaBytes(index.digest), phoneHmacKeyVersion: index.keyVersion });
    }
    if (dto.whatsapp_e164 !== undefined) {
      if (dto.whatsapp_e164 === null || dto.whatsapp_e164 === '') {
        Object.assign(data, { whatsappCiphertext: null, whatsappNonce: null, whatsappTag: null, whatsappEncryptedDek: null,
          whatsappKeyVersion: null, whatsappAadVersion: null, whatsappHmac: null, whatsappHmacKeyVersion: null });
      } else {
        const [encrypted, index] = await Promise.all([
          this.encryptContact(dto.whatsapp_e164, 'whatsapp', userId, id), this.crypto.blindIndex(dto.whatsapp_e164, 'assistance_providers.whatsapp'),
        ]);
      Object.assign(data, { whatsappCiphertext: prismaBytes(encrypted.ciphertext), whatsappNonce: prismaBytes(encrypted.nonce), whatsappTag: prismaBytes(encrypted.tag),
        whatsappEncryptedDek: prismaBytes(encrypted.encryptedDek), whatsappKeyVersion: encrypted.keyVersion, whatsappAadVersion: encrypted.aadVersion ?? 2,
        whatsappHmac: prismaBytes(index.digest), whatsappHmacKeyVersion: index.keyVersion });
      }
    }
    if (Object.keys(data).length === 0 && !latitudePresent && dto.coverage_geojson === undefined) throw new BadRequestException({
      code: 'EMPTY_PROVIDER_UPDATE', message: 'Debes indicar al menos un campo para actualizar.', details: {},
    });

    await this.prisma.$transaction(async (tx) => {
      if (Object.keys(data).length) await tx.assistanceProvider.update({ where: { id }, data });
      if (latitudePresent && longitudePresent) {
        await tx.$executeRaw(Prisma.sql`
          UPDATE public.assistance_providers
          SET base_location = ST_SetSRID(ST_MakePoint(${dto.longitude!}, ${dto.latitude!}), 4326)::geography
          WHERE id = ${id}::uuid AND user_id = ${userId}::uuid
        `);
      }
      if (dto.coverage_geojson !== undefined) {
        await tx.$executeRaw(Prisma.sql`
          UPDATE public.assistance_providers SET coverage_area =
            ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(dto.coverage_geojson)}), 4326))
          WHERE id = ${id}::uuid AND user_id = ${userId}::uuid
        `);
      }
      if (latitudePresent || dto.coverage_geojson !== undefined) await this.assertCoverageValid(tx, id);
      const requiresReverification = dto.phone_e164 !== undefined || dto.coverage_geojson !== undefined || latitudePresent
        || dto.address_reference_text !== undefined || dto.department_id !== undefined || dto.municipality_id !== undefined
        || dto.service_type_id !== undefined;
      if (existing.status === 'active' && requiresReverification) {
        await tx.assistanceProvider.update({ where: { id }, data: { status: 'pending_verification', verifiedAt: null } });
      }
    });
    const changedVerifiedFields = dto.phone_e164 !== undefined || dto.coverage_geojson !== undefined || latitudePresent
      || dto.address_reference_text !== undefined || dto.department_id !== undefined || dto.municipality_id !== undefined
      || dto.service_type_id !== undefined;
    return { id, status: existing.status === 'active' && changedVerifiedFields ? 'pending_verification' : existing.status };
  }

  async submitProviderForVerification(userId: string, id: string): Promise<Record<string, unknown>> {
    const provider = await this.prisma.assistanceProvider.findFirst({ where: { id, userId, deletedAt: null } });
    if (!provider) throw this.providerNotFound();
    const rows = await this.prisma.$queryRaw<Array<{ ready: boolean }>>(Prisma.sql`
      SELECT (p.base_location IS NOT NULL AND p.coverage_area IS NOT NULL
        AND nullif(btrim(p.address_reference_text), '') IS NOT NULL AND p.phone_ciphertext IS NOT NULL
        AND ST_IsValid(p.coverage_area)) AS ready
      FROM public.assistance_providers p WHERE p.id = ${id}::uuid AND p.user_id = ${userId}::uuid
    `);
    if (!rows[0]?.ready) throw new ConflictException({
      code: 'PROVIDER_PROFILE_INCOMPLETE', message: 'Completa teléfono, referencia, ubicación GPS y polígono de cobertura antes de solicitar verificación.', details: {},
    });
    await this.prisma.assistanceProvider.update({ where: { id }, data: { status: 'pending_verification' } });
    return { id, status: 'pending_verification' };
  }

  async updateProviderStatusByAdmin(id: string, status: 'active' | 'suspended' | 'pending_verification'): Promise<Record<string, unknown>> {
    const provider = await this.prisma.assistanceProvider.findFirst({ where: { id, deletedAt: null } });
    if (!provider) throw this.providerNotFound();
    const verifiedAt = status === 'active' ? new Date() : null;
    const result = await this.prisma.assistanceProvider.update({ where: { id }, data: { status, verifiedAt } });
    return { id: result.id, status: result.status, verified_at: result.verifiedAt };
  }

  async ownerMetrics(userId: string, id: string): Promise<Record<string, unknown>> {
    const provider = await this.prisma.assistanceProvider.findFirst({ where: { id, userId, deletedAt: null }, select: { id: true, name: true } });
    if (!provider) throw this.providerNotFound();
    const rows = await this.prisma.assistanceRequest.groupBy({ by: ['status'], where: { assistanceProviderId: id, requestedAt: { gte: new Date(Date.now() - 30 * 86400000) } }, _count: { _all: true } });
    return { provider_id: id, provider_name: provider.name, period_days: 30,
      assistance_requests: Object.fromEntries(rows.map((row) => [row.status, row._count._all])) };
  }

  async getOwnedProviders(userId: string): Promise<Record<string, unknown>> {
    const records = await this.prisma.assistanceProvider.findMany({
      where: { userId, deletedAt: null }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      select: { id: true, name: true, providerType: true, description: true, status: true, is24Hours: true,
        availabilityStatus: true, verifiedAt: true, addressReferenceText: true, updatedAt: true,
        serviceType: { select: { id: true, name: true } }, department: { select: { id: true, name: true } },
        municipality: { select: { id: true, name: true } }, },
    });
    return { items: records.map((r) => ({ id: r.id, name: r.name, provider_type: r.providerType,
      description: r.description, status: r.status, is_24_hours: r.is24Hours, availability_status: r.availabilityStatus,
      verified_at: r.verifiedAt, address_reference_text: r.addressReferenceText, service_type: r.serviceType,
      department: r.department, municipality: r.municipality, updated_at: r.updatedAt })), count: records.length, fetched_at: new Date().toISOString() };
  }

  async getOwnedProvider(userId: string, id: string): Promise<Record<string, unknown>> {
    const row = await this.prisma.assistanceProvider.findFirst({ where: { id, userId, deletedAt: null }, include: {
      serviceType: { select: { id: true, name: true } }, department: { select: { id: true, name: true } }, municipality: { select: { id: true, name: true } },
    } });
    if (!row) throw this.providerNotFound();
    const [contact, geo] = await Promise.all([this.decryptProviderContact(row), this.prisma.$queryRaw<Array<{ latitude: number | null; longitude: number | null; coverage_geojson: string | null }>>(Prisma.sql`
      SELECT ST_Y(base_location::geometry) AS latitude, ST_X(base_location::geometry) AS longitude,
        ST_AsGeoJSON(coverage_area)::text AS coverage_geojson
      FROM public.assistance_providers WHERE id = ${id}::uuid AND user_id = ${userId}::uuid
    `)]);
    return { id: row.id, name: row.name, provider_type: row.providerType, service_type: row.serviceType,
      description: row.description, phone_e164: contact.phone, whatsapp_e164: contact.whatsapp,
      address_reference_text: row.addressReferenceText, department: row.department, municipality: row.municipality,
      latitude: geo[0]?.latitude ?? null, longitude: geo[0]?.longitude ?? null,
      coverage_geojson: geo[0]?.coverage_geojson ? JSON.parse(geo[0].coverage_geojson) : null,
      is_24_hours: row.is24Hours, availability_status: row.availabilityStatus, status: row.status,
      verified_at: row.verifiedAt, created_at: row.createdAt, updated_at: row.updatedAt };
  }

  async searchProviders(query: SearchAssistanceProvidersQueryDto): Promise<Record<string, unknown>> {
    this.assertQueryPoint(query.lat, query.lng);
    const rows = await this.findCoveredProviders(query.lat!, query.lng!, query.radius_meters, query.limit, query.service_type_id);
    const contacts = await this.loadProviderContacts(rows.map((row) => row.id));
    const fetchedAt = new Date();
    const providers = await Promise.all(rows.map(async (row) => {
      const provider = contacts.get(row.id);
      if (!provider) return null;
      const contact = await this.decryptProviderContact(provider);
      const phoneDigits = contact.phone?.replace(/\D/g, '') ?? null;
      const whatsappDigits = contact.whatsapp?.replace(/\D/g, '') ?? null;
      const hasPrice = row.price_min !== null && row.price_max !== null;
      const stale = row.price_updated_at ? fetchedAt.getTime() - new Date(row.price_updated_at).getTime() > STALE_PRICE_AFTER_DAYS * 86400000 : false;
      return {
        id: row.id, name: provider.name, provider_type: provider.providerType,
        service_type: { id: provider.serviceTypeId, name: row.service_name },
        address_reference_text: provider.addressReferenceText,
        department: row.department_name, municipality: row.municipality_name,
        latitude: row.latitude, longitude: row.longitude,
        distance_meters: Math.round(row.distance_meters), is_24_hours: provider.is24Hours,
        availability_status: provider.availabilityStatus, verified: Boolean(provider.verifiedAt), verified_at: provider.verifiedAt,
        contact_actions: {
          call: phoneDigits ? { label: 'Llamar', url: `tel:+${phoneDigits}`, phone_e164: contact.phone } : null,
          whatsapp: whatsappDigits ? { label: 'WhatsApp', url: `https://wa.me/${whatsappDigits}` } : null,
        },
        ...(hasPrice ? { price_estimate: { minimum: Number(row.price_min), maximum: Number(row.price_max), currency: 'USD',
          status: stale ? 'desactualizado' : 'actualizado', disclaimer: PRICE_DISCLAIMER } } : {}),
      };
    }));
    const cleanProviders = providers.filter((item): item is NonNullable<typeof item> => item !== null);
    const emergency = cleanProviders.length === 0 ? await this.getGeneralEmergencyNumbers() : [];
    return { providers: cleanProviders, count: cleanProviders.length, coverage_found: cleanProviders.length > 0,
      emergency_alternative: cleanProviders.length === 0 ? emergency : [], generated_at: fetchedAt.toISOString(),
      cache_ttl_seconds: OFFLINE_PACKAGE_TTL_SECONDS };
  }

  async getOfflineEmergencyPackage(query: SearchAssistanceProvidersQueryDto): Promise<Record<string, unknown>> {
    this.assertQueryPoint(query.lat, query.lng);
    const cacheKey = `assistance:offline:v2:${query.lat!.toFixed(5)}:${query.lng!.toFixed(5)}:${query.radius_meters}:${query.limit}`;
    try {
      const cached = await this.redis.client.get(cacheKey);
      if (cached) return JSON.parse(cached) as Record<string, unknown>;
    } catch { /* Redis es un acelerador; la base de datos conserva la fuente de verdad. */ }

    const rows = await this.findCoveredProviders(query.lat!, query.lng!, query.radius_meters, Math.min(query.limit, 50));
    const contacts = await this.loadProviderContacts(rows.map((row) => row.id));
    const generatedAt = new Date();
    const compact = await Promise.all(rows.map(async (row) => {
      const provider = contacts.get(row.id);
      if (!provider) return null;
      const contact = await this.decryptProviderContact(provider);
      return {
        id: row.id, n: provider.name, t: provider.providerType, p: contact.phone,
        w: contact.whatsapp, r: provider.addressReferenceText, a: provider.availabilityStatus, d: row.department_name,
        m: row.municipality_name, lat: row.latitude, lng: row.longitude,
        v: Boolean(provider.verifiedAt), v_at: provider.verifiedAt?.toISOString() ?? null,
        h24: provider.is24Hours,
      };
    }));
    const emergencyNumbers = await this.getVerifiedEmergencyNumbers();
    const payload: Record<string, unknown> = {
      version: 1, generated_at: generatedAt.toISOString(), expires_at: new Date(generatedAt.getTime() + OFFLINE_PACKAGE_TTL_SECONDS * 1000).toISOString(),
      ttl_seconds: OFFLINE_PACKAGE_TTL_SECONDS, center: { lat: query.lat, lng: query.lng }, radius_meters: query.radius_meters,
      providers: compact.filter((item): item is NonNullable<typeof item> => item !== null),
      emergency_numbers: emergencyNumbers.map((row) => ({ id: row.id, label: row.label, phone: row.phone_number, call_url: `tel:${row.phone_number}`, source: row.source_name, verified_at: row.verified_at })),
      emergency_alternative: rows.length === 0 ? await this.getGeneralEmergencyNumbers() : [],
      fallback: rows.length === 0 ? 'No se encontraron proveedores verificados con cobertura en esta zona. Usa los números oficiales verificados disponibles.' : null,
      note: 'La disponibilidad puede cambiar mientras el dispositivo esté sin conexión.',
    };
    let serialized = JSON.stringify(payload);
    // El paquete tiene límite duro; si una zona excepcionalmente densa rebasa 100 KB, conserva los más cercanos.
    const providerItems = payload.providers as Array<Record<string, unknown>>;
    while (Buffer.byteLength(serialized, 'utf8') > OFFLINE_PACKAGE_MAX_BYTES && providerItems.length > 0) {
      providerItems.pop(); serialized = JSON.stringify(payload);
    }
    if (Buffer.byteLength(serialized, 'utf8') > OFFLINE_PACKAGE_MAX_BYTES) throw new ConflictException({
      code: 'OFFLINE_PACKAGE_TOO_LARGE', message: 'Los datos oficiales de emergencia exceden el tamaño admitido para la descarga offline.', details: { max_bytes: OFFLINE_PACKAGE_MAX_BYTES },
    });
    const updatePackageSize = (): number => {
      payload.size_bytes = 0;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const actual = Buffer.byteLength(JSON.stringify(payload), 'utf8');
        if (payload.size_bytes === actual) break;
        payload.size_bytes = actual;
      }
      return Buffer.byteLength(JSON.stringify(payload), 'utf8');
    };
    let finalSize = updatePackageSize();
    while (finalSize > OFFLINE_PACKAGE_MAX_BYTES && providerItems.length > 0) {
      providerItems.pop();
      finalSize = updatePackageSize();
    }
    if (finalSize > OFFLINE_PACKAGE_MAX_BYTES) throw new ConflictException({
      code: 'OFFLINE_PACKAGE_TOO_LARGE', message: 'El paquete excede el límite de 100 KB.', details: { max_bytes: OFFLINE_PACKAGE_MAX_BYTES },
    });
    try { await this.redis.client.set(cacheKey, JSON.stringify(payload), 'EX', 300); } catch { /* Ignorar falla de caché. */ }
    return payload;
  }

  async createRequest(userId: string, dto: CreateAssistanceRequestDto): Promise<Record<string, unknown>> {
    this.assertCoordinatePair(dto.latitude, dto.longitude);
    const reference = dto.address_reference_text.trim();
    if (!reference) throw new BadRequestException({ code: 'ADDRESS_REFERENCE_REQUIRED', message: 'La referencia textual de ubicación es obligatoria, incluso cuando se envían coordenadas GPS.', details: {} });
    // Un reintento HTTP con el mismo UUID v7 no debe crear una segunda solicitud ni volver a notificar.
    const prior = await this.prisma.assistanceRequest.findUnique({ where: { id: dto.id }, select: {
      id: true, userId: true, status: true, serviceTypeId: true, assistanceProviderId: true, createdAt: true,
    } });
    if (prior) {
      if (prior.userId !== userId) throw new ConflictException({ code: 'ASSISTANCE_REQUEST_ID_CONFLICT', message: 'El identificador de solicitud ya está utilizado.', details: {} });
      let coverageFound = Boolean(prior.assistanceProviderId);
      let coverageChecked = false;
      let notificationQueued = false;
      if (prior.status === 'created') {
        const savedPoint = await this.prisma.$queryRaw<Array<{ latitude: number | null; longitude: number | null }>>(Prisma.sql`
          SELECT ST_Y(location::geometry)::float8 AS latitude, ST_X(location::geometry)::float8 AS longitude
          FROM public.assistance_requests WHERE id = ${prior.id}::uuid AND user_id = ${userId}::uuid
        `);
        const point = savedPoint[0];
        if (point?.latitude !== null && point?.latitude !== undefined && point.longitude !== null && point.longitude !== undefined) {
          coverageChecked = true;
          const match = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT p.id FROM public.assistance_providers p
            WHERE p.status = 'active'::public.workshop_status AND p.verified_at IS NOT NULL AND p.deleted_at IS NULL
              AND p.availability_status <> 'unavailable' AND p.coverage_area IS NOT NULL
              AND ST_Covers(p.coverage_area, ST_SetSRID(ST_MakePoint(${point.longitude}, ${point.latitude}), 4326))
              AND p.service_type_id = ${prior.serviceTypeId}::uuid
            ORDER BY (p.availability_status = 'available') DESC, p.is_24_hours DESC,
              ST_Distance(p.base_location, ST_SetSRID(ST_MakePoint(${point.longitude}, ${point.latitude}), 4326)::geography) ASC
            LIMIT 1
          `);
          coverageFound = match.length > 0;
          if (coverageFound) {
            await this.queue.enqueueRequest(prior.id);
            notificationQueued = true;
          }
        }
      }
      return { id: prior.id, status: prior.status, idempotent_replay: true,
        coverage_checked: coverageChecked, coverage_found: coverageFound, notification_queued: notificationQueued,
        emergency_alternative: coverageFound ? [] : await this.getGeneralEmergencyNumbers(),
        created_at: prior.createdAt.toISOString() };
    }

    const request = await this.prisma.$transaction(async (tx) => {
      await this.rateLimit.assertWithinLimit(tx, userId);
      // La misma barrera de concurrencia usada por B5S evita violar el índice único
      // de solicitudes activas tanto desde /assistance-requests como desde /sync/push.
      await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
      const duplicate = await tx.assistanceRequest.findFirst({ where: {
        userId, vehicleId: dto.vehicle_id ?? null, deletedAt: null,
        status: { in: ['created', 'sent', 'accepted', 'en_camino'] },
      }, select: { id: true } });
      if (duplicate) throw new ConflictException({
        code: 'ASSISTANCE_ALREADY_SUBMITTED',
        message: 'Ya existe una solicitud de asistencia activa para este vehículo.',
        details: { request_id: duplicate.id },
      });
      const serviceType = await tx.serviceType.findFirst({ where: { id: dto.service_type_id, isActive: true }, select: { id: true } });
      if (!serviceType) throw new BadRequestException({ code: 'SERVICE_TYPE_INVALID', message: 'El tipo de servicio no existe o está inactivo.', details: {} });
      if (dto.vehicle_id) {
        const vehicle = await tx.vehicle.findFirst({ where: { id: dto.vehicle_id, userId, deletedAt: null }, select: { id: true } });
        if (!vehicle) throw new BadRequestException({ code: 'RESOURCE_NOT_OWNED', message: 'El vehículo indicado no pertenece a la cuenta activa.', details: {} });
      }
      await this.assertTerritory(dto.department_id ?? null, dto.municipality_id ?? null, tx);
      const encryptedContact = dto.contact_phone ? await this.encryptRequestPhone(dto.contact_phone, userId, dto.id) : null;
      const created = await tx.assistanceRequest.create({ data: {
        id: dto.id, userId, vehicleId: dto.vehicle_id ?? null, serviceTypeId: dto.service_type_id,
        issueDescription: dto.issue_description.trim(), addressReferenceText: reference,
        departmentId: dto.department_id ?? null, municipalityId: dto.municipality_id ?? null,
        preferredContact: dto.preferred_contact ?? 'whatsapp', status: 'created',
        ...(encryptedContact ?? {}),
      } });
      if (dto.latitude !== undefined && dto.longitude !== undefined) await tx.$executeRaw(Prisma.sql`
        UPDATE public.assistance_requests SET location = ST_SetSRID(ST_MakePoint(${dto.longitude}, ${dto.latitude}), 4326)::geography
        WHERE id = ${dto.id}::uuid AND user_id = ${userId}::uuid
      `);
      await tx.assistanceRequestEvent.create({ data: { requestId: dto.id, fromStatus: null, toStatus: 'created', actorType: 'driver', actorUserId: userId } });
      return created;
    });

    let coverageFound = false;
    const coverageChecked = dto.latitude !== undefined && dto.longitude !== undefined;
    if (coverageChecked) {
      const match = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT p.id FROM public.assistance_providers p
        WHERE p.status = 'active'::public.workshop_status AND p.verified_at IS NOT NULL AND p.deleted_at IS NULL
          AND p.availability_status <> 'unavailable' AND p.coverage_area IS NOT NULL
          AND ST_Covers(p.coverage_area, ST_SetSRID(ST_MakePoint(${dto.longitude}, ${dto.latitude}), 4326))
          AND p.service_type_id = ${dto.service_type_id}::uuid
        ORDER BY (p.availability_status = 'available') DESC, p.is_24_hours DESC,
          ST_Distance(p.base_location, ST_SetSRID(ST_MakePoint(${dto.longitude}, ${dto.latitude}), 4326)::geography) ASC
        LIMIT 1
      `);
      coverageFound = match.length > 0;
      if (coverageFound) await this.queue.enqueueRequest(request.id);
    }
    return { id: request.id, status: 'created', coverage_checked: coverageChecked,
      coverage_found: coverageFound, notification_queued: coverageFound,
      emergency_alternative: coverageFound ? [] : await this.getGeneralEmergencyNumbers(),
      message: coverageFound ? 'Solicitud recibida. Estamos contactando al proveedor.'
        : coverageChecked ? 'No hay proveedores verificados con cobertura para esta ubicación; contacta directamente a un número oficial disponible.'
          : 'Solicitud recibida, pero no fue posible comprobar cobertura porque faltan coordenadas GPS. Contacta directamente a un número oficial disponible.',
      created_at: request.createdAt.toISOString() };
  }

  async listMyRequests(userId: string, query: AssistanceHistoryQueryDto): Promise<Record<string, unknown>> {
    const [rows, total] = await Promise.all([
      this.prisma.assistanceRequest.findMany({ where: { userId, deletedAt: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: query.offset, take: query.limit, include: ASSISTANCE_REQUEST_HISTORY_INCLUDE }),
      this.prisma.assistanceRequest.count({ where: { userId, deletedAt: null } }),
    ]);
    return { items: rows.map((row) => this.serializeRequestHistory(row)), total, limit: query.limit, offset: query.offset,
      fetched_at: new Date().toISOString() };
  }

  async getMyRequest(userId: string, id: string): Promise<Record<string, unknown>> {
    const row = await this.prisma.assistanceRequest.findFirst({ where: { id, userId, deletedAt: null }, include: ASSISTANCE_REQUEST_HISTORY_INCLUDE });
    if (!row) throw new NotFoundException({ code: 'ASSISTANCE_REQUEST_NOT_FOUND', message: 'No se encontró la solicitud.', details: {} });
    const coords = await this.prisma.$queryRaw<Array<{ latitude: number | null; longitude: number | null }>>(Prisma.sql`
      SELECT ST_Y(location::geometry) AS latitude, ST_X(location::geometry) AS longitude FROM public.assistance_requests WHERE id = ${id}::uuid
    `);
    return { ...this.serializeRequestHistory(row), latitude: coords[0]?.latitude ?? null, longitude: coords[0]?.longitude ?? null };
  }

  async cancelMyRequest(userId: string, id: string): Promise<Record<string, unknown>> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM public.assistance_requests WHERE id = ${id}::uuid AND user_id = ${userId}::uuid FOR UPDATE`);
      const row = await tx.assistanceRequest.findFirst({ where: { id, userId, deletedAt: null } });
      if (!row) throw new NotFoundException({ code: 'ASSISTANCE_REQUEST_NOT_FOUND', message: 'No se encontró la solicitud.', details: {} });
      if (!['created', 'sent'].includes(row.status)) throw new ConflictException({ code: 'INVALID_STATE_TRANSITION', message: 'La solicitud ya no puede cancelarse desde la cuenta del conductor.', details: { status: row.status } });
      const updated = await tx.assistanceRequest.update({ where: { id }, data: { status: 'cancelled', cancelledAt: new Date() } });
      await tx.assistanceRequestEvent.create({ data: { requestId: id, fromStatus: row.status, toStatus: 'cancelled', actorType: 'driver', actorUserId: userId } });
      await tx.assistanceActionToken.updateMany({ where: { requestId: id, usedAt: null }, data: { usedAt: new Date() } });
      return { id, status: updated.status, cancelled_at: updated.cancelledAt };
    });
  }

  async previewProviderAction(rawToken: string): Promise<Record<string, unknown>> {
    const tokenHash = this.hashActionToken(rawToken);
    const row = await this.prisma.assistanceActionToken.findFirst({ where: { tokenHash: prismaBytes(tokenHash) }, include: { request: { select: { id: true, issueDescription: true, addressReferenceText: true, status: true, assistanceProvider: { select: { name: true } } } } } });
    if (!row) throw new GoneException({ code: 'ASSISTANCE_ACTION_TOKEN_INVALID', message: 'El enlace no existe o ya no está disponible.', details: {} });
    if (row.usedAt || row.expiresAt <= new Date()) throw new GoneException({ code: 'ASSISTANCE_ACTION_TOKEN_EXPIRED', message: 'El enlace ya se utilizó o venció. Solicita un nuevo enlace al sistema.', details: {} });
    return { request_id: row.requestId, target_status: row.targetStatus, current_status: row.request.status,
      provider_name: row.request.assistanceProvider?.name ?? null, issue_description: row.request.issueDescription,
      address_reference_text: row.request.addressReferenceText, expires_at: row.expiresAt.toISOString(),
      confirmation_method: 'POST /assistance-actions/{token}/confirm' };
  }

  async consumeProviderAction(rawToken: string): Promise<Record<string, unknown>> {
    const tokenHash = this.hashActionToken(rawToken);
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const reference = await tx.$queryRaw<Array<{ request_id: string }>>(Prisma.sql`
        SELECT request_id FROM public.assistance_action_tokens WHERE token_hash = ${tokenHash}
      `);
      if (!reference[0]) throw new GoneException({ code: 'ASSISTANCE_ACTION_TOKEN_INVALID', message: 'El enlace no existe o ya no está disponible.', details: {} });
      // Orden de bloqueo estable: solicitud y luego token. Evita deadlocks con cancelación del conductor.
      await tx.$queryRaw(Prisma.sql`SELECT id FROM public.assistance_requests WHERE id = ${reference[0].request_id}::uuid FOR UPDATE`);
      const locked = await tx.$queryRaw<Array<{ id: string; request_id: string; target_status: string; expires_at: Date; used_at: Date | null }>>(Prisma.sql`
        SELECT id, request_id, target_status, expires_at, used_at
        FROM public.assistance_action_tokens WHERE token_hash = ${tokenHash} FOR UPDATE
      `);
      const token = locked[0];
      if (!token || token.request_id !== reference[0].request_id) throw new GoneException({ code: 'ASSISTANCE_ACTION_TOKEN_INVALID', message: 'El enlace no existe o ya no está disponible.', details: {} });
      if (token.used_at || token.expires_at <= now) throw new GoneException({ code: 'ASSISTANCE_ACTION_TOKEN_EXPIRED', message: 'El enlace ya se utilizó o venció.', details: {} });
      const request = await tx.assistanceRequest.findUnique({ where: { id: token.request_id } });
      if (!request) throw new NotFoundException({ code: 'ASSISTANCE_REQUEST_NOT_FOUND', message: 'No se encontró la solicitud asociada.', details: {} });
      const target = token.target_status;
      const allowed: Record<string, string[]> = { sent: ['accepted', 'cancelled'], accepted: ['en_camino', 'cancelled'], en_camino: ['completed', 'cancelled'] };
      if (!(allowed[request.status] ?? []).includes(target)) throw new ConflictException({
        code: 'INVALID_STATE_TRANSITION', message: 'La solicitud ya cambió de estado y este enlace dejó de ser válido.', details: { status: request.status, target_status: target },
      });
      const used = await tx.assistanceActionToken.updateMany({ where: { id: token.id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
      if (used.count !== 1) throw new GoneException({ code: 'ASSISTANCE_ACTION_TOKEN_USED', message: 'El enlace ya fue utilizado.', details: {} });
      await tx.assistanceActionToken.updateMany({ where: { requestId: request.id, usedAt: null }, data: { usedAt: now } });
      const updated = await tx.assistanceRequest.update({ where: { id: request.id }, data: {
        status: target,
        ...(target === 'accepted' ? { acceptedAt: now } : {}),
        ...(target === 'en_camino' ? { enRouteAt: now } : {}),
        ...(target === 'completed' ? { completedAt: now } : {}),
        ...(target === 'cancelled' ? { cancelledAt: now } : {}),
      } });
      await tx.assistanceRequestEvent.create({ data: { requestId: request.id, fromStatus: request.status, toStatus: target, actorType: 'provider' } });
      const nextTargets = target === 'accepted' ? ['en_camino', 'cancelled'] : target === 'en_camino' ? ['completed', 'cancelled'] : [];
      const nextActions: Array<Record<string, unknown>> = [];
      for (const nextTarget of nextTargets) {
        const raw = randomBytes(32).toString('base64url');
        const expiresAt = new Date(now.getTime() + this.config.value.assistanceActionTokenTtlSeconds * 1000);
        await tx.assistanceActionToken.create({ data: {
          requestId: request.id, tokenHash: prismaBytes(this.hashActionToken(raw)), targetStatus: nextTarget, expiresAt,
        } });
        nextActions.push({ target_status: nextTarget, url: `${this.publicApiBaseUrl()}/assistance-actions/${raw}`, expires_at: expiresAt.toISOString() });
      }
      return { id: updated.id, status: updated.status, updated_at: updated.updatedAt.toISOString(), next_actions: nextActions };
    });
  }

  /** Trabajo ejecutado exclusivamente por BullMQ, después del commit de la solicitud. */
  async dispatchRequestNotification(requestId: string): Promise<Record<string, unknown>> {
    const request = await this.prisma.assistanceRequest.findFirst({ where: { id: requestId, deletedAt: null }, include: {
      user: { select: { id: true, displayName: true, phoneCiphertext: true, phoneNonce: true, phoneTag: true, phoneEncryptedDek: true, phoneKeyVersion: true } },
      serviceType: { select: { name: true } },
      vehicle: { select: { brandLabel: true, modelLabel: true, modelYear: true, vehicleType: true, nickname: true } },
    } });
    if (!request || request.status !== 'created') return { skipped: true, reason: 'request_not_dispatchable' };
    const coords = await this.prisma.$queryRaw<Array<{ latitude: number | null; longitude: number | null }>>(Prisma.sql`
      SELECT ST_Y(location::geometry) AS latitude, ST_X(location::geometry) AS longitude FROM public.assistance_requests WHERE id = ${requestId}::uuid
    `);
    const point = coords[0];
    if (point?.latitude === null || point?.latitude === undefined || point.longitude === null || point.longitude === undefined) return { skipped: true, reason: 'gps_missing' };

    const candidates = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT p.id FROM public.assistance_providers p
      WHERE p.status = 'active'::public.workshop_status AND p.verified_at IS NOT NULL AND p.deleted_at IS NULL
        AND p.availability_status <> 'unavailable' AND p.coverage_area IS NOT NULL
        AND p.service_type_id = ${request.serviceTypeId}::uuid
        AND ST_Covers(p.coverage_area, ST_SetSRID(ST_MakePoint(${point.longitude}, ${point.latitude}),4326))
      ORDER BY (p.availability_status = 'available') DESC, p.is_24_hours DESC,
        ST_Distance(p.base_location, ST_SetSRID(ST_MakePoint(${point.longitude}, ${point.latitude}),4326)::geography) ASC
      LIMIT 1
    `);
    if (!candidates.length) return { skipped: true, reason: 'no_provider_coverage' };
    const provider = await this.prisma.assistanceProvider.findFirst({ where: { id: candidates[0].id, status: 'active', deletedAt: null } });
    if (!provider) return { skipped: true, reason: 'provider_not_available' };
    const providerContact = await this.decryptProviderContact(provider);
    const userPhone = request.contactPhoneCiphertext && request.contactPhoneNonce && request.contactPhoneTag && request.contactPhoneEncryptedDek && request.contactPhoneKeyVersion
      ? await this.crypto.decrypt({ ciphertext: Buffer.from(request.contactPhoneCiphertext), nonce: Buffer.from(request.contactPhoneNonce),
        tag: Buffer.from(request.contactPhoneTag), encryptedDek: Buffer.from(request.contactPhoneEncryptedDek),
        keyVersion: request.contactPhoneKeyVersion, aadVersion: request.contactPhoneAadVersion ?? 2 }, 'assistance_requests.contact_phone', { userId: request.userId, recordId: request.id })
      : request.user.phoneCiphertext && request.user.phoneNonce && request.user.phoneTag && request.user.phoneEncryptedDek && request.user.phoneKeyVersion
        ? await this.crypto.decrypt({ ciphertext: Buffer.from(request.user.phoneCiphertext), nonce: Buffer.from(request.user.phoneNonce),
          tag: Buffer.from(request.user.phoneTag), encryptedDek: Buffer.from(request.user.phoneEncryptedDek), keyVersion: request.user.phoneKeyVersion, aadVersion: 1 }, 'users.phone')
        : 'No disponible';
    const mapUrl = `https://www.google.com/maps/search/?api=1&query=${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`;
    const vehicle = request.vehicle ? [request.vehicle.nickname, request.vehicle.brandLabel, request.vehicle.modelLabel, request.vehicle.modelYear]
      .filter((v) => v !== null && v !== undefined && String(v).trim()).join(' ') : 'No especificado';
    const tokenLinks = await this.createInitialProviderTokens(request.id);
    const body = [
      'SOLICITUD DE ASISTENCIA VIAL', `Solicitante: ${request.user.displayName}`, `Teléfono: ${userPhone}`,
      `Servicio: ${request.serviceType.name}`, `Vehículo: ${vehicle}`, `Descripción: ${request.issueDescription}`,
      `Referencia: ${request.addressReferenceText}`, `Ubicación: ${mapUrl}`,
      `Aceptar: ${tokenLinks.accept}`, `Cancelar: ${tokenLinks.cancel}`,
      'El enlace es personal, de un solo uso y tiene vencimiento. No se solicita ningún pago a través de este enlace.',
    ].join('\n');
    const recipient = providerContact.whatsapp ?? providerContact.phone;
    if (!recipient) throw new Error('ASSISTANCE_PROVIDER_CONTACT_MISSING');
    const channel = providerContact.whatsapp ? 'whatsapp' : 'sms';
    const sent = await this.notifier.send({ to: recipient, channel, body });
    const changed = await this.prisma.$transaction(async (tx) => {
      const result = await tx.assistanceRequest.updateMany({ where: { id: request.id, status: 'created' }, data: { status: 'sent', sentAt: new Date(), assistanceProviderId: provider.id } });
      if (result.count === 1) await tx.assistanceRequestEvent.create({ data: { requestId: request.id, fromStatus: 'created', toStatus: 'sent', actorType: 'system' } });
      return result.count;
    });
    return { sent: changed === 1, provider_id: provider.id, notification_provider: sent.provider, channel: sent.channel };
  }

  private async createInitialProviderTokens(requestId: string): Promise<{ accept: string; cancel: string }> {
    const now = new Date();
    const accept = randomBytes(32).toString('base64url');
    const cancel = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + this.config.value.assistanceActionTokenTtlSeconds * 1000);
    await this.prisma.$transaction(async (tx) => {
      await tx.assistanceActionToken.updateMany({ where: { requestId, usedAt: null }, data: { usedAt: now } });
      await tx.assistanceActionToken.createMany({ data: [
        { requestId, tokenHash: prismaBytes(this.hashActionToken(accept)), targetStatus: 'accepted', expiresAt },
        { requestId, tokenHash: prismaBytes(this.hashActionToken(cancel)), targetStatus: 'cancelled', expiresAt },
      ] });
    });
    return { accept: `${this.publicApiBaseUrl()}/assistance-actions/${accept}`, cancel: `${this.publicApiBaseUrl()}/assistance-actions/${cancel}` };
  }

  async getActionPageHtml(token: string): Promise<string> {
    const preview = await this.previewProviderAction(token);
    const target = String(preview.target_status);
    const label = this.statusLabel(target);
    const confirmUrl = `${this.publicApiBaseUrl()}/assistance-actions/${encodeURIComponent(token)}/confirm`;
    return this.htmlPage('Actualizar solicitud de asistencia', `
      <h1>Solicitud de asistencia vial</h1><p>Proveedor: ${this.escapeHtml(String(preview.provider_name ?? 'Proveedor'))}</p>
      <p>Referencia: ${this.escapeHtml(String(preview.address_reference_text))}</p>
      <p>Descripción: ${this.escapeHtml(String(preview.issue_description))}</p>
      <p>Esta acción actualizará la solicitud a: <strong>${this.escapeHtml(label)}</strong>.</p>
      <p>El enlace vence: ${this.escapeHtml(String(preview.expires_at))}</p>
      <form method="post" action="${this.escapeHtml(confirmUrl)}"><button type="submit">Confirmar ${this.escapeHtml(label)}</button></form>
      <p>Este enlace solo funciona una vez y no solicita pagos.</p>`);
  }

  async getActionResultHtml(token: string): Promise<string> {
    const result = await this.consumeProviderAction(token);
    const links = (result.next_actions as Array<{target_status: string; url: string}>).map((item) =>
      `<li><a href="${this.escapeHtml(item.url)}">${this.escapeHtml(this.statusLabel(item.target_status))}</a></li>`).join('');
    return this.htmlPage('Estado actualizado', `<h1>Estado actualizado</h1><p>La solicitud ahora está: <strong>${this.escapeHtml(this.statusLabel(String(result.status)))}</strong>.</p>
      ${links ? `<p>Siguiente actualización disponible (cada enlace se usa una sola vez):</p><ul>${links}</ul>` : '<p>La solicitud ha finalizado.</p>'}`);
  }

  private async findCoveredProviders(lat: number, lng: number, radius: number, limit: number, serviceTypeId?: string): Promise<ProviderSearchRow[]> {
    return this.prisma.$queryRaw<ProviderSearchRow[]>(Prisma.sql`
      SELECT p.id,
        ST_Distance(p.base_location, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography)::float8 AS distance_meters,
        ST_Y(p.base_location::geometry)::float8 AS latitude, ST_X(p.base_location::geometry)::float8 AS longitude,
        so.price_min::text AS price_min, so.price_max::text AS price_max, so.price_updated_at,
        st.name AS service_name, d.name AS department_name, m.name AS municipality_name
      FROM public.assistance_providers p
      JOIN public.service_types st ON st.id = p.service_type_id AND st.is_active = TRUE
      LEFT JOIN public.departments d ON d.id = p.department_id
      LEFT JOIN public.municipalities m ON m.id = p.municipality_id
      LEFT JOIN LATERAL (
        SELECT MIN(s.price_min) AS price_min, MAX(s.price_max) AS price_max, MIN(s.last_updated_at) AS price_updated_at
        FROM public.service_offerings s
        WHERE s.assistance_provider_id = p.id AND s.service_type_id = p.service_type_id
          AND s.is_active = TRUE AND s.publication_status = 'published'::public.service_offering_status AND s.deleted_at IS NULL
      ) so ON TRUE
      WHERE p.status = 'active'::public.workshop_status AND p.verified_at IS NOT NULL AND p.deleted_at IS NULL
        AND p.coverage_area IS NOT NULL AND p.base_location IS NOT NULL
        AND p.availability_status <> 'unavailable'
        AND ST_Covers(p.coverage_area, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326))
        AND ST_DWithin(p.base_location, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, ${radius})
        AND (${serviceTypeId ?? null}::uuid IS NULL OR p.service_type_id = ${serviceTypeId ?? null}::uuid)
      ORDER BY (p.availability_status = 'available') DESC, p.is_24_hours DESC,
        ST_Distance(p.base_location, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography) ASC, p.id ASC
      LIMIT ${limit}
    `);
  }

  private async loadProviderContacts(ids: string[]): Promise<Map<string, Prisma.AssistanceProviderGetPayload<Prisma.AssistanceProviderDefaultArgs>>> {
    if (!ids.length) return new Map();
    const rows = await this.prisma.assistanceProvider.findMany({ where: { id: { in: ids }, status: 'active', verifiedAt: { not: null }, deletedAt: null } });
    return new Map(rows.map((row) => [row.id, row]));
  }

  private async getVerifiedEmergencyNumbers(): Promise<Array<Record<string, unknown>>> {
    const rows = await this.prisma.emergencyNumber.findMany({
      where: { isActive: true, verified: true },
      orderBy: [{ category: 'asc' }, { label: 'asc' }],
      select: { id: true, label: true, category: true, phoneNumber: true, sourceName: true, sourceUrl: true, verifiedAt: true },
    });
    return rows.map((row) => ({ id: row.id, label: row.label, category: row.category, phone_number: row.phoneNumber,
      call_url: `tel:${row.phoneNumber}`, source_name: row.sourceName, source_url: row.sourceUrl,
      verified_at: row.verifiedAt?.toISOString() ?? null, verified: true }));
  }

  private async getGeneralEmergencyNumbers(): Promise<Array<Record<string, unknown>>> {
    // Solo números ingresados y verificados en el catálogo oficial; nunca se inventan números de emergencia.
    const rows = await this.prisma.$queryRaw<Array<{ id: string; label: string; category: string; phone_number: string; source_name: string | null; source_url: string | null; verified_at: Date | null }>>(Prisma.sql`
      SELECT id, label, category, phone_number, source_name, source_url, verified_at
      FROM public.emergency_numbers
      WHERE is_active = TRUE AND verified = TRUE
        AND lower(category) IN ('general','general_emergency','general_emergencia','emergencia_general','national')
      ORDER BY label ASC
    `);
    return rows.map((row) => ({ id: row.id, label: row.label, category: row.category, phone_number: row.phone_number,
      call_url: `tel:${row.phone_number}`, source_name: row.source_name, source_url: row.source_url,
      verified_at: row.verified_at?.toISOString() ?? null, verified: true }));
  }

  private async decryptProviderContact(row: ContactColumns): Promise<{ phone: string | null; whatsapp: string | null }> {
    const phone = row.phoneCiphertext && row.phoneNonce && row.phoneTag && row.phoneEncryptedDek && row.phoneKeyVersion
      ? await this.crypto.decrypt({ ciphertext: Buffer.from(row.phoneCiphertext), nonce: Buffer.from(row.phoneNonce), tag: Buffer.from(row.phoneTag),
        encryptedDek: Buffer.from(row.phoneEncryptedDek), keyVersion: row.phoneKeyVersion, aadVersion: row.phoneAadVersion ?? 2 },
        'assistance_providers.phone', { userId: row.userId, recordId: row.id }) : null;
    const whatsapp = row.whatsappCiphertext && row.whatsappNonce && row.whatsappTag && row.whatsappEncryptedDek && row.whatsappKeyVersion
      ? await this.crypto.decrypt({ ciphertext: Buffer.from(row.whatsappCiphertext), nonce: Buffer.from(row.whatsappNonce), tag: Buffer.from(row.whatsappTag),
        encryptedDek: Buffer.from(row.whatsappEncryptedDek), keyVersion: row.whatsappKeyVersion, aadVersion: row.whatsappAadVersion ?? 2 },
        'assistance_providers.whatsapp', { userId: row.userId, recordId: row.id }) : null;
    return { phone, whatsapp };
  }

  private async encryptContact(value: string, type: 'phone' | 'whatsapp', userId: string, recordId: string) {
    return this.crypto.encrypt(value, `assistance_providers.${type}`, { userId, recordId });
  }

  private async encryptRequestPhone(value: string, userId: string, recordId: string) {
    const [encrypted, index] = await Promise.all([
      this.crypto.encrypt(value, 'assistance_requests.contact_phone', { userId, recordId }),
      this.crypto.blindIndex(value, 'assistance_requests.contact_phone'),
    ]);
    return { contactPhoneCiphertext: prismaBytes(encrypted.ciphertext), contactPhoneNonce: prismaBytes(encrypted.nonce), contactPhoneTag: prismaBytes(encrypted.tag),
      contactPhoneEncryptedDek: prismaBytes(encrypted.encryptedDek), contactPhoneKeyVersion: encrypted.keyVersion,
      contactPhoneAadVersion: encrypted.aadVersion ?? 2, contactPhoneHmac: prismaBytes(index.digest), contactPhoneHmacKeyVersion: index.keyVersion };
  }

  private async assertTerritory(departmentId: string | null, municipalityId: string | null, db: PrismaService | Prisma.TransactionClient = this.prisma): Promise<void> {
    if (municipalityId && !departmentId) throw new BadRequestException({ code: 'MUNICIPALITY_REQUIRES_DEPARTMENT', message: 'El municipio requiere departamento.', details: {} });
    if (departmentId) {
      const department = await db.department.findFirst({ where: { id: departmentId, isActive: true }, select: { id: true } });
      if (!department) throw new BadRequestException({ code: 'DEPARTMENT_INVALID', message: 'El departamento no existe o está inactivo.', details: {} });
    }
    if (municipalityId) {
      const municipality = await db.municipality.findFirst({ where: { id: municipalityId, departmentId: departmentId!, isActive: true }, select: { id: true } });
      if (!municipality) throw new BadRequestException({ code: 'MUNICIPALITY_INVALID', message: 'El municipio no pertenece al departamento indicado o está inactivo.', details: {} });
    }
  }

  private async assertCoverageValid(tx: Prisma.TransactionClient, id: string): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ valid: boolean }>>(Prisma.sql`
      SELECT coverage_area IS NOT NULL AND ST_IsValid(coverage_area) AND NOT ST_IsEmpty(coverage_area)
        AND ST_SRID(coverage_area) = 4326 AND GeometryType(coverage_area) = 'MULTIPOLYGON' AS valid
      FROM public.assistance_providers WHERE id = ${id}::uuid
    `);
    if (!rows[0]?.valid) throw new BadRequestException({ code: 'INVALID_COVERAGE_POLYGON', message: 'El polígono de cobertura no es válido. Envía un GeoJSON Polygon o MultiPolygon válido.', details: {} });
  }

  private validateCoverageGeoJson(value: Record<string, unknown>): void {
    if (!value || !['Polygon', 'MultiPolygon'].includes(String(value.type)) || !Array.isArray(value.coordinates)) throw new BadRequestException({
      code: 'INVALID_COVERAGE_GEOJSON', message: 'coverage_geojson debe ser GeoJSON Polygon o MultiPolygon (WGS84).', details: {},
    });
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded, 'utf8') > 250_000) throw new BadRequestException({ code: 'COVERAGE_GEOJSON_TOO_LARGE', message: 'El polígono supera el tamaño permitido de 250 KB.', details: {} });
    const positions: unknown[] = [];
    const collect = (node: unknown): void => {
      if (!Array.isArray(node)) return;
      if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') positions.push(node);
      else for (const child of node) collect(child);
    };
    collect(value.coordinates);
    if (positions.length < 4 || positions.length > 10_000) throw new BadRequestException({ code: 'COVERAGE_VERTEX_LIMIT', message: 'El polígono debe contener entre 4 y 10 000 pares de coordenadas.', details: {} });
    for (const position of positions as number[][]) {
      if (!Number.isFinite(position[0]) || !Number.isFinite(position[1]) || position[0] < -180 || position[0] > 180 || position[1] < -90 || position[1] > 90) {
        throw new BadRequestException({ code: 'COVERAGE_COORDINATE_OUT_OF_RANGE', message: 'El polígono debe utilizar coordenadas WGS84 válidas: longitud [-180,180] y latitud [-90,90].', details: {} });
      }
    }
  }

  private assertCoordinatePair(lat?: number, lng?: number): void {
    if ((lat === undefined) !== (lng === undefined)) throw new BadRequestException({ code: 'COORDINATE_PAIR_REQUIRED', message: 'latitude y longitude deben enviarse juntas.', details: {} });
  }
  private assertQueryPoint(lat?: number, lng?: number): void {
    if (lat === undefined || lng === undefined) throw new BadRequestException({ code: 'GPS_REQUIRED', message: 'Se requieren lat y lng para consultar cobertura geográfica.', details: {} });
  }
  private hashActionToken(token: string): Uint8Array<ArrayBuffer> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new GoneException({ code: 'ASSISTANCE_ACTION_TOKEN_INVALID', message: 'El enlace no es válido.', details: {} });
    return prismaBytes(createHash('sha256').update(token, 'utf8').digest());
  }
  private publicApiBaseUrl(): string {
    return (this.config.value.publicApiBaseUrl ?? `http://localhost:${this.config.value.appPort}/${this.config.value.apiPrefix}`).replace(/\/$/, '');
  }
  private serializeRequestHistory(row: AssistanceRequestHistoryRow): Record<string, unknown> {
    return { id: row.id, status: row.status, issue_description: row.issueDescription, address_reference_text: row.addressReferenceText,
      service_type: row.serviceType, vehicle: row.vehicle, provider: row.assistanceProvider,
      requested_at: row.requestedAt.toISOString(), sent_at: row.sentAt?.toISOString() ?? null,
      accepted_at: row.acceptedAt?.toISOString() ?? null, en_camino_at: row.enRouteAt?.toISOString() ?? null,
      completed_at: row.completedAt?.toISOString() ?? null, cancelled_at: row.cancelledAt?.toISOString() ?? null,
      created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString(),
      events: row.events.map((event) => ({ from_status: event.fromStatus, to_status: event.toStatus,
        actor_type: event.actorType, created_at: event.createdAt.toISOString() })) };
  }
  private statusLabel(status: string): string {
    return ({ accepted: 'Aceptada', en_camino: 'En camino', completed: 'Completada', cancelled: 'Cancelada' } as Record<string, string>)[status] ?? status;
  }
  private htmlPage(title: string, body: string): string {
    return `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${this.escapeHtml(title)}</title><body style="font-family:system-ui,sans-serif;max-width:680px;margin:40px auto;padding:24px;line-height:1.5"><main>${body}</main></body></html>`;
  }
  private escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
  }
  private providerNotFound(): NotFoundException {
    return new NotFoundException({ code: 'ASSISTANCE_PROVIDER_NOT_FOUND', message: 'No se encontró el proveedor.', details: {} });
  }
}
