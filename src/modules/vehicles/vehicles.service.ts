import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { prismaBytes } from '../../database/prisma-bytes';
import { FieldCryptoService } from '../../security/field-crypto.service';
import { ObjectStorageService } from '../../storage/object-storage.service';
import { AppConfigService } from '../../config/config.module';
import type { CreateVehicleDto } from './dto/create-vehicle.dto';
import type { UpdateVehicleDto } from './dto/update-vehicle.dto';
import type { VehiclePhotoUploadDto } from './dto/vehicle-photo-upload.dto';
import type { ListVehiclesQueryDto } from './dto/list-vehicles-query.dto';

export const VEHICLE_INCLUDE = { brand: true, model: true } as const;
type VehicleRecord = Prisma.VehicleGetPayload<{ include: typeof VEHICLE_INCLUDE }>;
type VinEncryptedFields = Pick<Prisma.VehicleUncheckedCreateInput,
  'vinCiphertext' | 'vinNonce' | 'vinTag' | 'vinEncryptedDek' | 'vinKeyVersion' | 'vinAadVersion' | 'vinHmac' | 'vinHmacKeyVersion'>;

const ALLOWED_PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

@Injectable()
export class VehiclesService {
  private readonly logger = new Logger(VehiclesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: FieldCryptoService,
    private readonly storage: ObjectStorageService,
    private readonly config: AppConfigService,
  ) {}

  async create(userId: string, dto: CreateVehicleDto): Promise<Record<string, unknown>> {
    const plate = this.normalizePlate(dto.plate);
    const plateEncrypted = await this.crypto.encrypt(plate, 'vehicles.plate', { userId, recordId: dto.id });
    const plateIndex = await this.crypto.blindIndex(plate, 'vehicles.plate');
    const vinMaterial = dto.vin ? await this.encryptVin(dto.vin, userId, dto.id) : null;
    const creationInput = {
      plate,
      brandId: dto.brand_id ?? null,
      modelId: dto.model_id ?? null,
      brandLabel: dto.brand.trim(),
      modelLabel: dto.model.trim(),
      modelYear: dto.model_year,
      color: dto.color ?? null,
      vehicleType: dto.vehicle_type,
      nickname: dto.nickname ?? null,
      vin: dto.vin ?? null,
      mileageKm: dto.mileage_km ?? null,
    };

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        // Serializa los registros de vehículos por cuenta. Evita superar el límite
        // configurable cuando dos solicitudes llegan simultáneamente.
        await tx.$queryRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))
        `);

        const existing = await tx.vehicle.findUnique({ where: { id: dto.id }, include: VEHICLE_INCLUDE });
        if (existing) {
          if (existing.userId !== userId) throw this.idCollision();
          if (existing.deletedAt) throw new ConflictException({
            code: 'VEHICLE_ID_RETIRED',
            message: 'Este identificador ya corresponde a un vehículo eliminado y no puede reutilizarse.',
            details: { id: dto.id },
          });
          const sameRequest = await this.isSameCreation(existing, creationInput);
          if (!sameRequest) throw new ConflictException({
            code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
            message: 'Este identificador de vehículo ya fue utilizado con datos diferentes.',
            details: { id: dto.id },
          });
          return { record: existing, created: false };
        }

        const catalog = await this.resolveCatalog(tx, dto.brand_id ?? null, dto.model_id ?? null, dto.brand, dto.model);
        const duplicatePlate = await tx.vehicle.findFirst({
          where: { userId, plateHmac: prismaBytes(plateIndex.digest), deletedAt: null },
          select: { id: true },
        });
        if (duplicatePlate) throw this.plateConflict();

        const activeCount = await tx.vehicle.count({ where: { userId, deletedAt: null } });
        if (activeCount >= this.config.value.maxVehiclesPerUser) {
          throw new ConflictException({
            code: 'VEHICLE_LIMIT_REACHED',
            message: `Tu cuenta permite un máximo de ${this.config.value.maxVehiclesPerUser} vehículos activos.`,
            details: { maximum: this.config.value.maxVehiclesPerUser },
          });
        }

        const record = await tx.vehicle.create({
          data: {
            id: dto.id,
            userId,
            plateCiphertext: prismaBytes(plateEncrypted.ciphertext),
            plateNonce: prismaBytes(plateEncrypted.nonce),
            plateTag: prismaBytes(plateEncrypted.tag),
            plateEncryptedDek: prismaBytes(plateEncrypted.encryptedDek),
            plateKeyVersion: plateEncrypted.keyVersion,
            plateAadVersion: plateEncrypted.aadVersion ?? 2,
            plateHmac: prismaBytes(plateIndex.digest),
            plateHmacKeyVersion: plateIndex.keyVersion,
            brandId: catalog.brandId,
            brandLabel: catalog.brandLabel,
            modelId: catalog.modelId,
            modelLabel: catalog.modelLabel,
            modelYear: dto.model_year,
            color: dto.color ?? null,
            vehicleType: dto.vehicle_type,
            nickname: dto.nickname ?? null,
            ...(vinMaterial ? vinMaterial : {}),
            mileageKm: dto.mileage_km ?? null,
          },
          include: VEHICLE_INCLUDE,
        });
        return { record, created: true };
      });

      return this.toResponse(created.record, { idempotent: !created.created });
    } catch (error) {
      if (this.isUniqueError(error)) {
        const existingById = await this.prisma.vehicle.findUnique({ where: { id: dto.id }, include: VEHICLE_INCLUDE });
        if (existingById) {
          if (existingById.userId !== userId) throw this.idCollision();
          if (existingById.deletedAt) throw new ConflictException({
            code: 'VEHICLE_ID_RETIRED',
            message: 'Este identificador ya corresponde a un vehículo eliminado y no puede reutilizarse.',
            details: { id: dto.id },
          });
          if (await this.isSameCreation(existingById, creationInput)) {
            return this.toResponse(existingById, { idempotent: true });
          }
          throw new ConflictException({
            code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
            message: 'Este identificador de vehículo ya fue utilizado con datos diferentes.',
            details: { id: dto.id },
          });
        }
        throw this.plateConflict();
      }
      throw error;
    }
  }

  async list(userId: string, query: ListVehiclesQueryDto): Promise<Record<string, unknown>> {
    const limit = query.limit ?? 20;
    if (query.cursor) {
      const cursorRecord = await this.prisma.vehicle.findFirst({
        where: { id: query.cursor, userId, deletedAt: null },
        select: { id: true },
      });
      if (!cursorRecord) throw new BadRequestException({
        code: 'VEHICLE_CURSOR_INVALID',
        message: 'El cursor no pertenece a un vehículo activo de tu cuenta.',
        details: {},
      });
    }
    const rows = await this.prisma.vehicle.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: VEHICLE_INCLUDE,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = await Promise.all(page.map((row) => this.toResponse(row)));
    return {
      items,
      next_cursor: hasMore ? page[page.length - 1]?.id ?? null : null,
      has_more: hasMore,
      limit,
    };
  }

  async getOne(userId: string, id: string): Promise<Record<string, unknown>> {
    const vehicle = await this.findOwned(userId, id);
    return this.toResponse(vehicle);
  }

  async update(userId: string, id: string, dto: UpdateVehicleDto): Promise<Record<string, unknown>> {
    if (Object.values(dto).every((value) => value === undefined)) {
      throw new BadRequestException({
        code: 'EMPTY_VEHICLE_UPDATE',
        message: 'Debes indicar al menos un campo para actualizar.',
        details: {},
      });
    }

    const current = await this.findOwned(userId, id);
    const data: Prisma.VehicleUncheckedUpdateManyInput = {};

    if (dto.plate !== undefined) {
      const plate = this.normalizePlate(dto.plate);
      const encrypted = await this.crypto.encrypt(plate, 'vehicles.plate', { userId, recordId: id });
      const index = await this.crypto.blindIndex(plate, 'vehicles.plate');
      const duplicate = await this.prisma.vehicle.findFirst({
        where: { userId, plateHmac: prismaBytes(index.digest), deletedAt: null, id: { not: id } },
        select: { id: true },
      });
      if (duplicate) throw this.plateConflict();
      data.plateCiphertext = prismaBytes(encrypted.ciphertext);
      data.plateNonce = prismaBytes(encrypted.nonce);
      data.plateTag = prismaBytes(encrypted.tag);
      data.plateEncryptedDek = prismaBytes(encrypted.encryptedDek);
      data.plateKeyVersion = encrypted.keyVersion;
      data.plateAadVersion = encrypted.aadVersion ?? 2;
      data.plateHmac = prismaBytes(index.digest);
      data.plateHmacKeyVersion = index.keyVersion;
    }

    if (dto.brand !== undefined || dto.model !== undefined || dto.brand_id !== undefined || dto.model_id !== undefined) {
      let brandId = dto.brand_id !== undefined ? dto.brand_id : current.brandId;
      let modelId = dto.model_id !== undefined ? dto.model_id : current.modelId;
      if (dto.brand_id === null && dto.model_id === undefined) modelId = null;
      let brandLabel = dto.brand?.trim() ?? current.brandLabel;
      let modelLabel = dto.model?.trim() ?? current.modelLabel;

      if (dto.brand !== undefined && dto.brand_id === undefined) {
        brandId = null;
        modelId = null;
      } else if (dto.brand_id !== undefined && dto.brand_id !== current.brandId && dto.model_id === undefined) {
        modelId = null;
      }
      if (dto.model !== undefined && dto.model_id === undefined) modelId = null;

      const catalog = await this.resolveCatalog(
        this.prisma,
        brandId,
        modelId,
        brandLabel,
        modelLabel,
        brandId === current.brandId,
        modelId === current.modelId,
      );
      // Si el usuario seleccionó una opción de catálogo, se conserva el nombre
      // canónico; si no, se guarda la etiqueta libre escrita por el usuario.
      // El ID de catálogo es la fuente canónica cuando está presente; no se
      // permite guardar una etiqueta de texto que contradiga el identificador.
      if (brandId !== null) brandLabel = catalog.brandLabel;
      if (modelId !== null) modelLabel = catalog.modelLabel;
      data.brandId = catalog.brandId;
      data.brandLabel = brandLabel;
      data.modelId = catalog.modelId;
      data.modelLabel = modelLabel;
    }

    if (dto.model_year !== undefined) data.modelYear = dto.model_year;
    if (dto.vehicle_type !== undefined) data.vehicleType = dto.vehicle_type;
    if (dto.nickname !== undefined) data.nickname = dto.nickname;
    if (dto.color !== undefined) data.color = dto.color;
    if (dto.mileage_km !== undefined) data.mileageKm = dto.mileage_km;
    if (dto.vin !== undefined) {
      if (dto.vin === null) {
        data.vinCiphertext = null;
        data.vinNonce = null;
        data.vinTag = null;
        data.vinEncryptedDek = null;
        data.vinKeyVersion = null;
        data.vinAadVersion = null;
        data.vinHmac = null;
        data.vinHmacKeyVersion = null;
      } else {
        Object.assign(data, await this.encryptVin(dto.vin, userId, id));
      }
    }

    try {
      const result = await this.prisma.vehicle.updateMany({
        where: { id, userId, deletedAt: null },
        data,
      });
      if (result.count !== 1) throw this.notFound();
      const updated = await this.findOwned(userId, id);
      return this.toResponse(updated);
    } catch (error) {
      if (this.isUniqueError(error)) throw this.plateConflict();
      throw error;
    }
  }

  async delete(userId: string, id: string): Promise<Record<string, unknown>> {
    const deletedAt = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const vehicle = await tx.vehicle.findFirst({
        where: { id, userId, deletedAt: null },
        select: { id: true, photoObjectKey: true, photoPendingObjectKey: true },
      });
      if (!vehicle) throw this.notFound();

      const documentIds = (await tx.vehicleDocument.findMany({ where: { userId, vehicleId: id, deletedAt: null }, select: { id: true } })).map((doc) => doc.id);
      await tx.reminder.updateMany({
        where: { userId, vehicleDocumentId: { in: documentIds }, status: { in: ['scheduled', 'processing'] }, deletedAt: null },
        data: { status: 'cancelled', cancelledAt: deletedAt },
      });
      await tx.vehicleDocument.updateMany({
        where: { userId, vehicleId: id, deletedAt: null },
        data: { deletedAt },
      });
      await tx.insurancePolicy.updateMany({
        where: { userId, vehicleId: id, deletedAt: null },
        data: { deletedAt, status: 'archived', archivedAt: deletedAt },
      });

      const updated = await tx.vehicle.updateMany({
        where: { id, userId, deletedAt: null },
        // Conserva las keys privadas en el tombstone para que un futuro
        // reconciliador pueda completar la limpieza si S3 no responde.
        data: { deletedAt },
      });
      if (updated.count !== 1) throw this.notFound();
      return vehicle;
    });

    if (result.photoObjectKey) await this.storage.deleteObject(result.photoObjectKey);
    if (result.photoPendingObjectKey) await this.storage.deleteObject(result.photoPendingObjectKey);
    return { id, deleted_at: deletedAt.toISOString(), status: 'deleted' };
  }

  async summary(userId: string, id: string): Promise<Record<string, unknown>> {
    const vehicle = await this.findOwned(userId, id);
    const result = await this.prisma.$queryRaw<Array<{ document_count: number; next_expiration: string | null }>>(Prisma.sql`
      SELECT
        COUNT(*)::INTEGER AS document_count,
        to_char(MIN(valid_until) FILTER (
          WHERE valid_until >= (clock_timestamp() AT TIME ZONE 'America/Managua')::date
        ), 'YYYY-MM-DD') AS next_expiration
      FROM public.vehicle_documents
      WHERE user_id = ${userId}::uuid
        AND vehicle_id = ${id}::uuid
        AND deleted_at IS NULL
    `);
    return {
      vehicle: await this.toResponse(vehicle),
      document_count: result[0]?.document_count ?? 0,
      next_expiration: result[0]?.next_expiration ?? null,
    };
  }

  async createPhotoUploadUrl(userId: string, id: string, dto: VehiclePhotoUploadDto): Promise<Record<string, unknown>> {
    const vehicle = await this.findOwned(userId, id);
    if (!ALLOWED_PHOTO_TYPES.has(dto.content_type)) {
      throw new BadRequestException({
        code: 'PHOTO_TYPE_NOT_ALLOWED',
        message: 'El tipo de fotografía no está permitido.',
        details: { allowed_types: [...ALLOWED_PHOTO_TYPES] },
      });
    }
    if (dto.size_bytes > this.config.value.vehiclePhotoMaxBytes) {
      throw new PayloadTooLargeException({
        code: 'PHOTO_TOO_LARGE',
        message: 'La fotografía supera el tamaño máximo permitido.',
        details: { maximum_bytes: this.config.value.vehiclePhotoMaxBytes },
      });
    }

    const pendingKey = `users/${userId}/vehicles/${id}/photos/${randomUUID()}`;
    const signed = await this.storage.createUploadUrl(pendingKey, dto.content_type, dto.size_bytes);
    const updated = await this.prisma.vehicle.updateMany({
      where: { id, userId, deletedAt: null },
      data: {
        photoStatus: 'pending_upload',
        photoPendingObjectKey: pendingKey,
        photoPendingMimeType: dto.content_type,
        photoPendingSizeBytes: BigInt(dto.size_bytes),
      },
    });
    if (updated.count !== 1) throw this.notFound();
    if (vehicle.photoPendingObjectKey) await this.storage.deleteObject(vehicle.photoPendingObjectKey);

    return {
      vehicle_id: id,
      photo_status: 'pending_upload',
      upload_url: signed.url,
      expires_in_seconds: signed.expiresInSeconds,
      required_headers: {
        ...signed.requiredHeaders,
        'Content-Length': String(dto.size_bytes),
      },
      simulated: signed.simulated,
    };
  }

  async confirmPhotoUpload(userId: string, id: string): Promise<Record<string, unknown>> {
    const vehicle = await this.findOwned(userId, id);
    if (!vehicle.photoPendingObjectKey || !vehicle.photoPendingMimeType || vehicle.photoPendingSizeBytes === null) {
      throw new ConflictException({
        code: 'PHOTO_UPLOAD_NOT_PENDING',
        message: 'No existe una fotografía pendiente de confirmación para este vehículo.',
        details: {},
      });
    }

    const metadata = await this.storage.headObject(vehicle.photoPendingObjectKey);
    if (metadata.contentLength !== undefined && metadata.contentLength !== Number(vehicle.photoPendingSizeBytes)) {
      throw new ConflictException({
        code: 'PHOTO_SIZE_MISMATCH',
        message: 'El tamaño de la fotografía cargada no coincide con el declarado.',
        details: {},
      });
    }
    if (metadata.contentType !== undefined && metadata.contentType !== vehicle.photoPendingMimeType) {
      throw new ConflictException({
        code: 'PHOTO_TYPE_MISMATCH',
        message: 'El tipo de la fotografía cargada no coincide con el declarado.',
        details: {},
      });
    }

    const oldObjectKey = vehicle.photoObjectKey;
    const updated = await this.prisma.vehicle.updateMany({
      where: {
        id,
        userId,
        deletedAt: null,
        photoPendingObjectKey: vehicle.photoPendingObjectKey,
      },
      data: {
        photoStatus: 'available',
        photoObjectKey: vehicle.photoPendingObjectKey,
        photoMimeType: vehicle.photoPendingMimeType,
        photoSizeBytes: vehicle.photoPendingSizeBytes,
        photoPendingObjectKey: null,
        photoPendingMimeType: null,
        photoPendingSizeBytes: null,
      },
    });
    if (updated.count !== 1) throw new ConflictException({
      code: 'PHOTO_UPLOAD_STATE_CHANGED',
      message: 'El estado de la fotografía cambió. Solicita una nueva URL de subida.',
      details: {},
    });
    if (oldObjectKey && oldObjectKey !== vehicle.photoPendingObjectKey) await this.storage.deleteObject(oldObjectKey);
    return this.toResponse(await this.findOwned(userId, id));
  }

  private async findOwned(userId: string, id: string): Promise<VehicleRecord> {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id, userId, deletedAt: null },
      include: VEHICLE_INCLUDE,
    });
    if (!vehicle) throw this.notFound();
    return vehicle;
  }

  private async toResponse(vehicle: VehicleRecord, options: { idempotent?: boolean } = {}): Promise<Record<string, unknown>> {
    const plate = await this.crypto.decrypt({
      ciphertext: Buffer.from(vehicle.plateCiphertext),
      nonce: Buffer.from(vehicle.plateNonce),
      tag: Buffer.from(vehicle.plateTag),
      encryptedDek: Buffer.from(vehicle.plateEncryptedDek),
      keyVersion: vehicle.plateKeyVersion,
      aadVersion: vehicle.plateAadVersion,
    }, 'vehicles.plate', vehicle.plateAadVersion === 2 ? { userId: vehicle.userId, recordId: vehicle.id } : undefined);
    const vin = vehicle.vinCiphertext && vehicle.vinNonce && vehicle.vinTag && vehicle.vinEncryptedDek && vehicle.vinKeyVersion
      ? await this.crypto.decrypt({
          ciphertext: Buffer.from(vehicle.vinCiphertext),
          nonce: Buffer.from(vehicle.vinNonce),
          tag: Buffer.from(vehicle.vinTag),
          encryptedDek: Buffer.from(vehicle.vinEncryptedDek),
          keyVersion: vehicle.vinKeyVersion,
          aadVersion: vehicle.vinAadVersion ?? 1,
        }, 'vehicles.vin', vehicle.vinAadVersion === 2 ? { userId: vehicle.userId, recordId: vehicle.id } : undefined)
      : null;
    const photo = vehicle.photoObjectKey
      ? await this.storage.createDownloadUrl(vehicle.photoObjectKey)
      : null;
    return {
      id: vehicle.id,
      plate,
      brand_id: vehicle.brandId,
      brand: vehicle.brand?.name ?? vehicle.brandLabel,
      model_id: vehicle.modelId,
      model: vehicle.model?.name ?? vehicle.modelLabel,
      model_year: vehicle.modelYear,
      color: vehicle.color,
      vehicle_type: vehicle.vehicleType,
      alias: vehicle.nickname,
      vin,
      mileage_km: vehicle.mileageKm,
      photo_status: vehicle.photoStatus,
      photo_url: photo?.url ?? null,
      photo_url_expires_in_seconds: photo?.expiresInSeconds ?? null,
      photo_size_bytes: vehicle.photoSizeBytes?.toString() ?? null,
      created_at: vehicle.createdAt,
      updated_at: vehicle.updatedAt,
      deleted_at: vehicle.deletedAt,
      sync_version: vehicle.syncVersion.toString(),
      ...(options.idempotent ? { idempotent_replay: true } : {}),
    };
  }

  private async resolveCatalog(
    client: PrismaService | Prisma.TransactionClient,
    brandId: string | null,
    modelId: string | null,
    brandInput: string,
    modelInput: string,
    allowInactiveBrand = false,
    allowInactiveModel = false,
  ): Promise<{ brandId: string | null; modelId: string | null; brandLabel: string; modelLabel: string }> {
    let brandLabel = brandInput.trim();
    let modelLabel = modelInput.trim();
    if (brandId) {
      const brand = allowInactiveBrand
        ? await client.vehicleBrand.findUnique({ where: { id: brandId } })
        : await client.vehicleBrand.findFirst({ where: { id: brandId, isActive: true } });
      if (!brand) throw new BadRequestException({
        code: 'VEHICLE_BRAND_INVALID',
        message: 'La marca seleccionada no existe o no está disponible.',
        details: { brand_id: brandId },
      });
      brandLabel = brand.name;
    }
    if (modelId) {
      if (!brandId) throw new BadRequestException({
        code: 'VEHICLE_MODEL_BRAND_REQUIRED',
        message: 'Debes seleccionar una marca para utilizar un modelo del catálogo.',
        details: {},
      });
      const model = allowInactiveModel
        ? await client.vehicleModel.findFirst({ where: { id: modelId, brandId } })
        : await client.vehicleModel.findFirst({ where: { id: modelId, brandId, isActive: true } });
      if (!model) throw new BadRequestException({
        code: 'VEHICLE_MODEL_BRAND_MISMATCH',
        message: 'El modelo no pertenece a la marca seleccionada o no está disponible.',
        details: { brand_id: brandId, model_id: modelId },
      });
      modelLabel = model.name;
    }
    return { brandId, modelId, brandLabel, modelLabel };
  }

  private async encryptVin(vinValue: string, userId: string, recordId: string): Promise<VinEncryptedFields> {
    const vin = vinValue.trim().toUpperCase().replace(/\s+/g, '');
    const encrypted = await this.crypto.encrypt(vin, 'vehicles.vin', { userId, recordId });
    const index = await this.crypto.blindIndex(vin, 'vehicles.vin');
    return {
      vinCiphertext: prismaBytes(encrypted.ciphertext),
      vinNonce: prismaBytes(encrypted.nonce),
      vinTag: prismaBytes(encrypted.tag),
      vinEncryptedDek: prismaBytes(encrypted.encryptedDek),
      vinKeyVersion: encrypted.keyVersion,
      vinAadVersion: encrypted.aadVersion ?? 2,
      vinHmac: prismaBytes(index.digest),
      vinHmacKeyVersion: index.keyVersion,
    }; 
  }

  private async isSameCreation(
    existing: VehicleRecord,
    input: {
      plate: string; brandId: string | null; modelId: string | null; brandLabel: string; modelLabel: string;
      modelYear: number; color: string | null; vehicleType: string; nickname: string | null;
      vin: string | null; mileageKm: number | null;
    },
  ): Promise<boolean> {
    const existingPlate = await this.crypto.decrypt({
      ciphertext: Buffer.from(existing.plateCiphertext),
      nonce: Buffer.from(existing.plateNonce),
      tag: Buffer.from(existing.plateTag),
      encryptedDek: Buffer.from(existing.plateEncryptedDek),
      keyVersion: existing.plateKeyVersion,
      aadVersion: existing.plateAadVersion,
    }, 'vehicles.plate', existing.plateAadVersion === 2 ? { userId: existing.userId, recordId: existing.id } : undefined);
    const existingVin = existing.vinCiphertext && existing.vinNonce && existing.vinTag && existing.vinEncryptedDek && existing.vinKeyVersion
      ? await this.crypto.decrypt({
          ciphertext: Buffer.from(existing.vinCiphertext),
          nonce: Buffer.from(existing.vinNonce),
          tag: Buffer.from(existing.vinTag),
          encryptedDek: Buffer.from(existing.vinEncryptedDek),
          keyVersion: existing.vinKeyVersion,
          aadVersion: existing.vinAadVersion ?? 1,
        }, 'vehicles.vin', existing.vinAadVersion === 2 ? { userId: existing.userId, recordId: existing.id } : undefined)
      : null;
    return existingPlate === input.plate
      && existing.brandId === input.brandId
      && existing.modelId === input.modelId
      && (input.brandId !== null || this.normalizeCatalogLabel(existing.brandLabel) === this.normalizeCatalogLabel(input.brandLabel))
      && (input.modelId !== null || this.normalizeCatalogLabel(existing.modelLabel) === this.normalizeCatalogLabel(input.modelLabel))
      && existing.modelYear === input.modelYear
      && existing.color === input.color
      && existing.vehicleType === input.vehicleType
      && existing.nickname === input.nickname
      && existingVin === input.vin
      && existing.mileageKm === input.mileageKm;
  }

  private normalizeCatalogLabel(value: string): string {
    return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase('es-NI');
  }

  private normalizePlate(value: string): string {
    const normalized = value.toUpperCase().replace(/\s+/g, '');
    if (!/^[A-Z0-9-]{3,16}$/.test(normalized)) throw new BadRequestException({
      code: 'PLATE_FORMAT_INVALID',
      message: 'La placa debe contener entre 3 y 16 letras, números o guiones, sin espacios.',
      details: {},
    });
    return normalized;
  }

  private isUniqueError(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }

  private plateConflict(): ConflictException {
    return new ConflictException({
      code: 'PLATE_ALREADY_REGISTERED',
      message: 'Ya tienes otro vehículo activo con esa placa.',
      details: {},
    });
  }

  private idCollision(): ConflictException {
    return new ConflictException({
      code: 'ID_COLLISION',
      message: 'El identificador del vehículo ya está asociado a otro registro.',
      details: {},
    });
  }

  private notFound(): NotFoundException {
    return new NotFoundException({
      code: 'VEHICLE_NOT_FOUND',
      message: 'No se encontró el vehículo solicitado.',
      details: {},
    });
  }
}
