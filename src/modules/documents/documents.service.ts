import {
  BadRequestException, ConflictException, Injectable, NotFoundException,
  PayloadTooLargeException, UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { FieldCryptoService } from '../../security/field-crypto.service';
import { ObjectStorageService } from '../../storage/object-storage.service';
import { AppConfigService } from '../../config/config.module';
import type { CreateVehicleDocumentDto } from './dto/create-vehicle-document.dto';
import type { CreateDocumentUploadUrlDto } from './dto/create-document-upload-url.dto';
import type { CreateInsurancePolicyDto } from './dto/create-insurance-policy.dto';
import type { UpdateVehicleDocumentDto } from './dto/update-vehicle-document.dto';
import { RemindersService } from '../reminders/reminders.service';

const ALLOWED_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/heic']);
const MAX_FILE_BYTES = 10 * 1024 * 1024;
type DocumentRecord = Prisma.VehicleDocumentGetPayload<{}>;
type PolicyRecord = Prisma.InsurancePolicyGetPayload<{ include: { insurer: true; document: true } }>;

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: FieldCryptoService,
    private readonly storage: ObjectStorageService,
    private readonly config: AppConfigService,
    private readonly reminders: RemindersService,
  ) {}

  async list(userId: string, vehicleId: string): Promise<Record<string, unknown>> {
    await this.ensureVehicle(userId, vehicleId);
    const docs = await this.prisma.vehicleDocument.findMany({
      where: { userId, vehicleId, deletedAt: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return { items: await Promise.all(docs.map((doc) => this.documentResponse(doc))), count: docs.length };
  }

  async create(userId: string, vehicleId: string, dto: CreateVehicleDocumentDto): Promise<Record<string, unknown>> {
    await this.ensureVehicle(userId, vehicleId);
    this.validateDates(dto.valid_from, dto.valid_until);
    const existing = await this.prisma.vehicleDocument.findUnique({ where: { id: dto.id } });
    if (existing) {
      if (existing.userId !== userId) throw this.idCollision();
      if (existing.deletedAt) throw new ConflictException({ code: 'DOCUMENT_ID_RETIRED', message: 'Este identificador ya corresponde a un documento eliminado y no puede reutilizarse.', details: { id: dto.id } });
      const same = existing.vehicleId === vehicleId && existing.documentType === dto.document_type &&
        existing.title === dto.title && existing.issuerName === (dto.issuer_name ?? null) &&
        this.dateString(existing.validFrom) === (dto.valid_from ?? null) &&
        this.dateString(existing.validUntil) === (dto.valid_until ?? null);
      if (!same) throw new ConflictException({ code: 'IDEMPOTENCY_PAYLOAD_MISMATCH', message: 'Este identificador ya fue utilizado con datos diferentes.', details: { id: dto.id } });
      return { ...(await this.documentResponse(existing)), idempotent_replay: true };
    }
    const doc = await this.prisma.$transaction(async (tx) => {
      const created = await tx.vehicleDocument.create({ data: {
        id: dto.id, userId, vehicleId, documentType: dto.document_type, title: dto.title,
        issuerName: dto.issuer_name ?? null,
        validFrom: dto.valid_from ? this.toDate(dto.valid_from) : null,
        validUntil: dto.valid_until ? this.toDate(dto.valid_until) : null,
        fileStatus: 'pendiente_subida',
      } });
      await this.reminders.regenerateForDocument(tx, userId, created.id);
      return created;
    });
    return { ...(await this.documentResponse(doc)), idempotent_replay: false };
  }

  async update(userId: string, documentId: string, dto: UpdateVehicleDocumentDto): Promise<Record<string, unknown>> {
    const current = await this.findOwnedDocument(userId, documentId);
    if (current.insurancePolicyId && (dto.valid_from === null || dto.valid_until === null)) throw new BadRequestException({ code: 'POLICY_VALIDITY_REQUIRED', message: 'Una póliza debe conservar sus fechas de vigencia.', details: {} });
    const validFrom = dto.valid_from !== undefined ? dto.valid_from : this.dateString(current.validFrom);
    const validUntil = dto.valid_until !== undefined ? dto.valid_until : this.dateString(current.validUntil);
    this.validateDates(validFrom ?? undefined, validUntil ?? undefined);
    const updated = await this.prisma.$transaction(async (tx) => {
      const record = await tx.vehicleDocument.update({ where: { id: current.id }, data: {
        ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
        ...(dto.issuer_name !== undefined ? { issuerName: dto.issuer_name?.trim() || null } : {}),
        ...(dto.valid_from !== undefined ? { validFrom: dto.valid_from ? this.toDate(dto.valid_from) : null } : {}),
        ...(dto.valid_until !== undefined ? { validUntil: dto.valid_until ? this.toDate(dto.valid_until) : null } : {}),
      } });
      if (record.insurancePolicyId && (dto.valid_from !== undefined || dto.valid_until !== undefined)) {
        await tx.insurancePolicy.updateMany({
          where: { id: record.insurancePolicyId, userId, status: 'active', deletedAt: null },
          data: {
            ...(dto.valid_from !== undefined ? { validFrom: this.toDate(dto.valid_from!) } : {}),
            ...(dto.valid_until !== undefined ? { validUntil: this.toDate(dto.valid_until!) } : {}),
          },
        });
      }
      await this.reminders.regenerateForDocument(tx, userId, record.id);
      return record;
    });
    return this.documentResponse(updated);
  }

  async createPolicy(userId: string, vehicleId: string, dto: CreateInsurancePolicyDto): Promise<Record<string, unknown>> {
    await this.ensureVehicle(userId, vehicleId);
    this.validateDates(dto.valid_from, dto.valid_until, true);
    if (Boolean(dto.insurer_id) === Boolean(dto.other_insurer_name)) {
      throw new BadRequestException({ code: 'INSURER_SELECTION_INVALID', message: 'Selecciona una aseguradora del catálogo o indica el nombre de otra, pero no ambas opciones.', details: {} });
    }
    if (dto.insurer_id) {
      const insurer = await this.prisma.insurer.findFirst({ where: { id: dto.insurer_id, isActive: true }, select: { id: true } });
      if (!insurer) throw new BadRequestException({ code: 'INSURER_NOT_AVAILABLE', message: 'La aseguradora seleccionada no existe o no está disponible.', details: {} });
    }
    const number = await this.crypto.encrypt(dto.policy_number, 'insurance_policies.policy_number', { userId, recordId: dto.id });
    const phone = dto.claims_phone
      ? await this.crypto.encrypt(dto.claims_phone, 'insurance_policies.claims_phone', { userId, recordId: dto.id })
      : null;

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const replay = await tx.insurancePolicy.findUnique({ where: { id: dto.id }, include: { insurer: true, document: true } });
        if (replay) {
          if (replay.userId !== userId) throw this.idCollision();
          if (replay.deletedAt || replay.vehicleId !== vehicleId) throw new ConflictException({ code: 'IDEMPOTENCY_PAYLOAD_MISMATCH', message: 'El identificador de póliza ya fue utilizado para otro registro.', details: {} });
          const existingNumber = await this.crypto.decrypt({
            ciphertext: replay.policyNumberCiphertext, nonce: replay.policyNumberNonce, tag: replay.policyNumberTag,
            encryptedDek: replay.policyNumberEncryptedDek, keyVersion: replay.policyNumberKeyVersion,
            aadVersion: replay.policyNumberAadVersion,
          }, 'insurance_policies.policy_number', { userId, recordId: replay.id });
          const existingDocument = await tx.vehicleDocument.findUnique({ where: { insurancePolicyId: replay.id } });
          const existingPhone = replay.claimsPhoneCiphertext && replay.claimsPhoneNonce && replay.claimsPhoneTag && replay.claimsPhoneEncryptedDek && replay.claimsPhoneKeyVersion
            ? await this.crypto.decrypt({ ciphertext: replay.claimsPhoneCiphertext, nonce: replay.claimsPhoneNonce,
              tag: replay.claimsPhoneTag, encryptedDek: replay.claimsPhoneEncryptedDek,
              keyVersion: replay.claimsPhoneKeyVersion, aadVersion: replay.claimsPhoneAadVersion ?? 2 },
              'insurance_policies.claims_phone', { userId, recordId: replay.id }) : null;
          const same = existingNumber === dto.policy_number && existingPhone === (dto.claims_phone ?? null) && replay.insurerId === (dto.insurer_id ?? null) &&
            replay.otherInsurerName === (dto.other_insurer_name?.trim() ?? null) &&
            this.dateString(replay.validFrom) === dto.valid_from && this.dateString(replay.validUntil) === dto.valid_until &&
            replay.currency === dto.currency && (replay.deductible === null ? dto.deductible === undefined || dto.deductible === null : dto.deductible !== undefined && Number(replay.deductible) === dto.deductible) &&
            (replay.premium === null ? dto.premium === undefined || dto.premium === null : dto.premium !== undefined && Number(replay.premium) === dto.premium) &&
            existingDocument !== null && existingDocument.id === dto.document_id &&
            existingDocument.title === (dto.title?.trim() || 'Póliza de seguro') && existingDocument.issuerName === (dto.other_insurer_name?.trim() ?? null);
          if (!same) throw new ConflictException({ code: 'IDEMPOTENCY_PAYLOAD_MISMATCH', message: 'Este identificador de póliza ya fue utilizado con datos diferentes.', details: { id: dto.id } });
          return { policy: replay, replay: true };
        }
        const previous = await tx.insurancePolicy.findFirst({
          where: { userId, vehicleId, status: 'active', deletedAt: null }, orderBy: { createdAt: 'desc' },
        });
        if (previous) {
          await tx.insurancePolicy.update({ where: { id: previous.id }, data: { status: 'archived', archivedAt: new Date() } });
          const previousDocument = await tx.vehicleDocument.findUnique({ where: { insurancePolicyId: previous.id }, select: { id: true } });
          if (previousDocument) await this.reminders.cancelForDocument(tx, userId, previousDocument.id);
        }
        const policy = await tx.insurancePolicy.create({ data: {
          id: dto.id, userId, vehicleId, insurerId: dto.insurer_id ?? null,
          otherInsurerName: dto.other_insurer_name?.trim() ?? null,
          policyNumberCiphertext: number.ciphertext, policyNumberNonce: number.nonce,
          policyNumberTag: number.tag, policyNumberEncryptedDek: number.encryptedDek,
          policyNumberKeyVersion: number.keyVersion, policyNumberAadVersion: number.aadVersion ?? 2,
          validFrom: this.toDate(dto.valid_from), validUntil: this.toDate(dto.valid_until),
          deductible: dto.deductible ?? null, premium: dto.premium ?? null, currency: dto.currency,
          ...(phone ? { claimsPhoneCiphertext: phone.ciphertext, claimsPhoneNonce: phone.nonce,
            claimsPhoneTag: phone.tag, claimsPhoneEncryptedDek: phone.encryptedDek, claimsPhoneKeyVersion: phone.keyVersion,
            claimsPhoneAadVersion: phone.aadVersion ?? 2 } : {}),
          previousPolicyId: previous?.id ?? null,
          document: { create: {
            id: dto.document_id, userId, vehicleId, documentType: 'poliza',
            title: dto.title?.trim() || 'Póliza de seguro',
            issuerName: dto.other_insurer_name?.trim() ?? null,
            validFrom: this.toDate(dto.valid_from), validUntil: this.toDate(dto.valid_until),
            fileStatus: 'pendiente_subida',
          } },
        }, include: { insurer: true, document: true } });
        if (policy.document) await this.reminders.regenerateForDocument(tx, userId, policy.document.id);
        return { policy, replay: false };
      });
      return await this.policyResponse(created.policy, created.replay);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({ code: 'POLICY_CONFLICT', message: 'La póliza entra en conflicto con un registro existente. Actualiza y vuelve a intentar.', details: {} });
      }
      throw error;
    }
  }

  async policies(userId: string, vehicleId: string): Promise<Record<string, unknown>> {
    await this.ensureVehicle(userId, vehicleId);
    const policies = await this.prisma.insurancePolicy.findMany({
      where: { userId, vehicleId, deletedAt: null }, include: { insurer: true, document: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return { items: await Promise.all(policies.map((p) => this.policyResponse(p))), count: policies.length };
  }

  async createUploadUrl(userId: string, documentId: string, dto: CreateDocumentUploadUrlDto): Promise<Record<string, unknown>> {
    if (!ALLOWED_TYPES.has(dto.content_type)) throw this.fileTypeError();
    if (dto.size_bytes > MAX_FILE_BYTES) throw new PayloadTooLargeException({ code: 'DOCUMENT_FILE_TOO_LARGE', message: 'El archivo supera el máximo permitido de 10 MB.', details: { max_bytes: MAX_FILE_BYTES } });
    const doc = await this.findOwnedDocument(userId, documentId);
    if (doc.fileStatus === 'disponible') throw new ConflictException({ code: 'DOCUMENT_FILE_ALREADY_AVAILABLE', message: 'Este documento ya tiene un archivo disponible. Registra una nueva versión para reemplazarlo.', details: {} });
    const now = new Date();
    if (doc.pendingObjectKey && doc.pendingUrlIssuedAt) {
      const ageMs = now.getTime() - doc.pendingUrlIssuedAt.getTime();
      const ttlMs = this.config.value.awsS3PresignUploadTtlSeconds * 1000;
      if (ageMs < ttlMs) {
        const sameMetadata = doc.pendingContentType === dto.content_type && doc.pendingSizeBytes === BigInt(dto.size_bytes);
        throw new ConflictException({ code: 'DOCUMENT_UPLOAD_ALREADY_PENDING',
          message: sameMetadata
            ? 'La URL de subida anterior todavía puede utilizarse. Completa esa carga o espera a que expire antes de solicitar otra.'
            : 'Existe una subida con otros metadatos cuya URL todavía puede utilizarse. Espera a que expire antes de iniciar otra.',
          details: { retry_after_seconds: Math.ceil((ttlMs - ageMs) / 1000) } });
      }
    }
    // Una URL nueva siempre usa una key nueva: una URL anterior nunca puede sobrescribir
    // el objeto que el backend terminará confirmando. Las keys huérfanas se reconcilian por F-051.
    const key = `users/${userId}/vehicles/${doc.vehicleId}/documents/${randomUUID()}`;
    await this.prisma.vehicleDocument.update({ where: { id: doc.id }, data: {
      fileStatus: 'pendiente_subida', pendingObjectKey: key, pendingContentType: dto.content_type,
      pendingSizeBytes: BigInt(dto.size_bytes), pendingUrlIssuedAt: now,
      originalFileName: this.safeFileName(dto.file_name),
    } });
    const upload = await this.storage.createUploadUrl(key, dto.content_type, dto.size_bytes);
    return { document_id: doc.id, file_status: 'pendiente_subida', upload_url: upload.url,
      expires_in_seconds: upload.expiresInSeconds, required_headers: upload.requiredHeaders, simulated: upload.simulated };
  }

  async confirmUpload(userId: string, documentId: string): Promise<Record<string, unknown>> {
    const doc = await this.findOwnedDocument(userId, documentId);
    if (doc.fileStatus === 'disponible') return this.documentResponse(doc);
    if (!doc.pendingObjectKey || !doc.pendingContentType || !doc.pendingSizeBytes) {
      throw new ConflictException({ code: 'DOCUMENT_UPLOAD_NOT_STARTED', message: 'Primero solicita una URL firmada para subir el archivo.', details: {} });
    }
    const metadata = await this.storage.headObject(doc.pendingObjectKey);
    if (metadata.contentLength !== undefined && metadata.contentLength > MAX_FILE_BYTES) {
      throw new PayloadTooLargeException({ code: 'DOCUMENT_FILE_TOO_LARGE', message: 'El archivo subido supera el máximo permitido de 10 MB.', details: { max_bytes: MAX_FILE_BYTES } });
    }
    if (metadata.contentLength !== undefined && metadata.contentLength !== Number(doc.pendingSizeBytes)) {
      throw new UnprocessableEntityException({ code: 'DOCUMENT_FILE_SIZE_MISMATCH', message: 'El tamaño del archivo subido no coincide con el declarado.', details: { expected_bytes: Number(doc.pendingSizeBytes), actual_bytes: metadata.contentLength } });
    }
    if (metadata.contentType && metadata.contentType !== doc.pendingContentType) {
      throw new UnprocessableEntityException({ code: 'DOCUMENT_FILE_TYPE_MISMATCH', message: 'El tipo de archivo subido no coincide con el declarado.', details: {} });
    }
    const prefix = await this.storage.getObjectPrefix(doc.pendingObjectKey);
    let actualType = doc.pendingContentType;
    if (prefix) {
      actualType = this.detectMime(prefix) ?? '';
      if (!ALLOWED_TYPES.has(actualType) || actualType !== doc.pendingContentType) throw this.fileTypeError();
    } else if (this.config.value.nodeEnv === 'production') {
      throw new UnprocessableEntityException({ code: 'DOCUMENT_FILE_CONTENT_UNVERIFIED', message: 'No se pudo verificar el contenido real del archivo.', details: {} });
    }
    const updated = await this.prisma.vehicleDocument.update({ where: { id: doc.id }, data: {
      fileStatus: 'disponible', fileObjectKey: doc.pendingObjectKey, fileContentType: actualType,
      fileSizeBytes: doc.pendingSizeBytes, pendingObjectKey: null, pendingContentType: null, pendingSizeBytes: null, pendingUrlIssuedAt: null,
    } });
    return this.documentResponse(updated);
  }

  async downloadUrl(userId: string, documentId: string): Promise<Record<string, unknown>> {
    const doc = await this.findOwnedDocument(userId, documentId);
    if (doc.fileStatus !== 'disponible' || !doc.fileObjectKey) throw new ConflictException({
      code: 'DOCUMENT_FILE_NOT_AVAILABLE', message: 'El archivo todavía no está disponible para descargar.', details: { file_status: 'pendiente_subida' },
    });
    const signed = await this.storage.createDownloadUrl(doc.fileObjectKey);
    return { document_id: doc.id, download_url: signed.url, expires_in_seconds: signed.expiresInSeconds, simulated: signed.simulated };
  }

  async getOne(userId: string, documentId: string): Promise<Record<string, unknown>> {
    return this.documentResponse(await this.findOwnedDocument(userId, documentId));
  }

  private async ensureVehicle(userId: string, vehicleId: string): Promise<void> {
    const vehicle = await this.prisma.vehicle.findFirst({ where: { id: vehicleId, userId, deletedAt: null }, select: { id: true } });
    if (!vehicle) throw new NotFoundException({ code: 'VEHICLE_NOT_FOUND', message: 'No se encontró el vehículo solicitado.', details: {} });
  }
  private async findOwnedDocument(userId: string, id: string): Promise<DocumentRecord> {
    const doc = await this.prisma.vehicleDocument.findFirst({ where: { id, userId, deletedAt: null } });
    if (!doc) throw new NotFoundException({ code: 'DOCUMENT_NOT_FOUND', message: 'No se encontró el documento solicitado.', details: {} });
    return doc;
  }
  private async documentResponse(doc: DocumentRecord): Promise<Record<string, unknown>> {
    const today = this.managuaToday();
    const expiry = this.dateString(doc.validUntil);
    let status: string | null = null;
    if (expiry) {
      const diff = this.daysBetween(today, expiry);
      status = diff < 0 ? 'vencido' : diff <= this.config.value.documentExpiringSoonDays ? 'por_vencer' : 'vigente';
    }
    return {
      id: doc.id, vehicle_id: doc.vehicleId, document_type: doc.documentType, title: doc.title,
      issuer_name: doc.issuerName, valid_from: this.dateString(doc.validFrom), valid_until: expiry,
      insurance_policy_id: doc.insurancePolicyId, original_file_name: doc.originalFileName,
      status, file_status: doc.fileStatus, file_content_type: doc.fileContentType,
      file_size_bytes: doc.fileSizeBytes?.toString() ?? null,
      created_at: doc.createdAt.toISOString(), updated_at: doc.updatedAt.toISOString(),
      deleted_at: doc.deletedAt?.toISOString() ?? null, sync_version: doc.syncVersion.toString(),
    };
  }
  private async policyResponse(policy: PolicyRecord, replay = false): Promise<Record<string, unknown>> {
    const number = await this.crypto.decrypt({
      ciphertext: policy.policyNumberCiphertext, nonce: policy.policyNumberNonce, tag: policy.policyNumberTag,
      encryptedDek: policy.policyNumberEncryptedDek, keyVersion: policy.policyNumberKeyVersion,
      aadVersion: policy.policyNumberAadVersion,
    }, 'insurance_policies.policy_number', { userId: policy.userId, recordId: policy.id });
    const phone = policy.claimsPhoneCiphertext && policy.claimsPhoneNonce && policy.claimsPhoneTag &&
      policy.claimsPhoneEncryptedDek && policy.claimsPhoneKeyVersion
      ? await this.crypto.decrypt({ ciphertext: policy.claimsPhoneCiphertext, nonce: policy.claimsPhoneNonce,
        tag: policy.claimsPhoneTag, encryptedDek: policy.claimsPhoneEncryptedDek,
        keyVersion: policy.claimsPhoneKeyVersion, aadVersion: policy.claimsPhoneAadVersion ?? 2 },
        'insurance_policies.claims_phone', { userId: policy.userId, recordId: policy.id }) : null;
    const today = this.managuaToday();
    const expiry = this.dateString(policy.validUntil)!;
    const diff = this.daysBetween(today, expiry);
    return {
      id: policy.id, vehicle_id: policy.vehicleId, insurer: policy.insurer ? { id: policy.insurer.id, name: policy.insurer.name } : null,
      other_insurer_name: policy.otherInsurerName, policy_number: number, valid_from: this.dateString(policy.validFrom),
      valid_until: expiry, deductible: policy.deductible?.toString() ?? null, premium: policy.premium?.toString() ?? null,
      currency: policy.currency, claims_phone: phone, status: diff < 0 ? 'vencido' : diff <= this.config.value.documentExpiringSoonDays ? 'por_vencer' : 'vigente',
      history_status: policy.status, previous_policy_id: policy.previousPolicyId,
      archived_at: policy.archivedAt?.toISOString() ?? null, deleted_at: policy.deletedAt?.toISOString() ?? null,
      document: policy.document ? await this.documentResponse(policy.document) : null,
      created_at: policy.createdAt.toISOString(), updated_at: policy.updatedAt.toISOString(),
      sync_version: policy.syncVersion.toString(), ...(replay ? { idempotent_replay: true } : {}),
    };
  }
  private validateDates(from?: string | null, until?: string | null, required = false): void {
    if (required && (!from || !until)) throw new BadRequestException({ code: 'POLICY_VALIDITY_REQUIRED', message: 'La póliza requiere fecha de inicio y fin de vigencia.', details: {} });
    if (from && until && until <= from) throw new BadRequestException({ code: 'DOCUMENT_VALIDITY_INVALID', message: 'La fecha de fin de vigencia debe ser posterior a la fecha de inicio.', details: {} });
  }
  private toDate(value: string): Date { return new Date(`${value}T00:00:00.000Z`); }
  private dateString(value: Date | null): string | null { return value ? value.toISOString().slice(0, 10) : null; }
  private managuaToday(): string {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Managua', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
    return `${part('year')}-${part('month')}-${part('day')}`;
  }
  private daysBetween(from: string, to: string): number {
    return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
  }
  private detectMime(prefix: Buffer): string | null {
    if (prefix.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
    if (prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) return 'image/jpeg';
    if (prefix.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
    if (prefix.length >= 12 && prefix.subarray(4, 8).toString('ascii') === 'ftyp') {
      const brand = prefix.subarray(8, 12).toString('ascii');
      if (['heic','heix','hevc','hevx','heim','heis'].includes(brand)) return 'image/heic';
      if (['mif1','msf1'].includes(brand)) return 'image/heic';
    }
    return null;
  }
  private safeFileName(name?: string): string | null {
    if (!name) return null;
    return name.replace(/[\\/\x00-\x1f]/g, '_').slice(0, 255);
  }
  private fileTypeError(): UnprocessableEntityException {
    return new UnprocessableEntityException({ code: 'DOCUMENT_FILE_TYPE_NOT_ALLOWED', message: 'Formato no permitido. Solo se aceptan PDF, JPG, PNG y HEIC.', details: { allowed_types: [...ALLOWED_TYPES] } });
  }
  private idCollision(): ConflictException { return new ConflictException({ code: 'ID_COLLISION', message: 'El identificador ya pertenece a otro usuario.', details: {} }); }
}
