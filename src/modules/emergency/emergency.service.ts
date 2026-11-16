import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { FieldCryptoService } from '../../security/field-crypto.service';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import type { CreateEmergencyContactDto } from './dto/create-emergency-contact.dto';
import type { UpdateEmergencyContactDto } from './dto/update-emergency-contact.dto';
import type { ShareEmergencyMessageDto } from './dto/share-emergency-message.dto';

@Injectable()
export class EmergencyService {
  constructor(private readonly prisma: PrismaService, private readonly crypto: FieldCryptoService) {}

  async listContacts(userId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await this.prisma.emergencyContact.findMany({
      where: { userId, deletedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return Promise.all(rows.map((row) => this.serializeContact(row)));
  }

  async createContact(userId: string, dto: CreateEmergencyContactDto): Promise<Record<string, unknown>> {
    const existing = await this.prisma.emergencyContact.findUnique({ where: { id: dto.id } });
    if (existing) {
      const phoneIndex = await this.crypto.blindIndex(dto.phone_e164, 'emergency_contacts.phone');
      const relationship = dto.relationship_label?.trim() || null;
      if (existing.userId === userId && existing.deletedAt === null && existing.phoneHmac && Buffer.from(existing.phoneHmac).equals(phoneIndex.digest)
        && existing.name === dto.name.trim() && existing.relationshipLabel === relationship) return this.serializeContact(existing);
      throw new ConflictException({ code: 'EMERGENCY_CONTACT_ID_CONFLICT', message: 'El identificador del contacto ya está utilizado.', details: {} });
    }

    const phone = dto.phone_e164.trim();
    const [encrypted, index] = await Promise.all([
      this.crypto.encrypt(phone, 'emergency_contacts.phone', { userId, recordId: dto.id }),
      this.crypto.blindIndex(phone, 'emergency_contacts.phone'),
    ]);

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
        const count = await tx.emergencyContact.count({ where: { userId, deletedAt: null } });
        if (count >= 5) throw new ConflictException({
          code: 'EMERGENCY_CONTACT_LIMIT_REACHED', message: 'Solo puedes registrar hasta cinco contactos de emergencia.', details: { maximum: 5 },
        });
        if (dto.is_primary === true) await tx.emergencyContact.updateMany({
          where: { userId, deletedAt: null, isPrimary: true }, data: { isPrimary: false },
        });
        return tx.emergencyContact.create({
          data: {
            id: dto.id, userId, name: dto.name.trim(), relationshipLabel: dto.relationship_label?.trim() ?? null,
            isPrimary: dto.is_primary ?? false,
            phoneCiphertext: encrypted.ciphertext, phoneNonce: encrypted.nonce, phoneTag: encrypted.tag,
            phoneEncryptedDek: encrypted.encryptedDek, phoneKeyVersion: encrypted.keyVersion,
            phoneAadVersion: encrypted.aadVersion ?? 2, phoneHmac: index.digest, phoneHmacKeyVersion: index.keyVersion,
          },
        });
      });
      return this.serializeContact(row);
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      if (this.isMaxContactsDbError(error)) throw new ConflictException({
        code: 'EMERGENCY_CONTACT_LIMIT_REACHED', message: 'Solo puedes registrar hasta cinco contactos de emergencia.', details: { maximum: 5 },
      });
      throw error;
    }
  }

  async updateContact(userId: string, id: string, dto: UpdateEmergencyContactDto): Promise<Record<string, unknown>> {
    const existing = await this.prisma.emergencyContact.findFirst({ where: { id, userId, deletedAt: null } });
    if (!existing) throw new NotFoundException({ code: 'EMERGENCY_CONTACT_NOT_FOUND', message: 'No se encontró el contacto de emergencia.', details: {} });
    const data: Prisma.EmergencyContactUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.relationship_label !== undefined) data.relationshipLabel = dto.relationship_label?.trim() || null;
    if (dto.is_primary !== undefined) data.isPrimary = dto.is_primary;
    if (dto.phone_e164 !== undefined) {
      const phone = dto.phone_e164.trim();
      const [encrypted, index] = await Promise.all([
        this.crypto.encrypt(phone, 'emergency_contacts.phone', { userId, recordId: id }),
        this.crypto.blindIndex(phone, 'emergency_contacts.phone'),
      ]);
      Object.assign(data, {
        phoneCiphertext: encrypted.ciphertext, phoneNonce: encrypted.nonce, phoneTag: encrypted.tag,
        phoneEncryptedDek: encrypted.encryptedDek, phoneKeyVersion: encrypted.keyVersion,
        phoneAadVersion: encrypted.aadVersion ?? 2, phoneHmac: index.digest, phoneHmacKeyVersion: index.keyVersion,
      });
    }
    if (Object.keys(data).length === 0) throw new BadRequestException({
      code: 'EMPTY_EMERGENCY_CONTACT_UPDATE', message: 'Debes indicar al menos un campo para actualizar.', details: {},
    });
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
      if (dto.is_primary === true) await tx.emergencyContact.updateMany({
        where: { userId, deletedAt: null, isPrimary: true, id: { not: id } }, data: { isPrimary: false },
      });
      const result = await tx.emergencyContact.updateMany({ where: { id, userId, deletedAt: null }, data });
      if (result.count !== 1) throw new NotFoundException({ code: 'EMERGENCY_CONTACT_NOT_FOUND', message: 'No se encontró el contacto de emergencia.', details: {} });
      return tx.emergencyContact.findFirstOrThrow({ where: { id, userId, deletedAt: null } });
    });
    return this.serializeContact(row);
  }

  async deleteContact(userId: string, id: string): Promise<{ id: string; deleted: true }> {
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
      return tx.emergencyContact.updateMany({
        where: { id, userId, deletedAt: null },
        data: {
          deletedAt: now,
          phoneCiphertext: null, phoneNonce: null, phoneTag: null, phoneEncryptedDek: null,
          phoneKeyVersion: null, phoneAadVersion: null, phoneHmac: null, phoneHmacKeyVersion: null,
        },
      });
    });
    if (result.count !== 1) throw new NotFoundException({ code: 'EMERGENCY_CONTACT_NOT_FOUND', message: 'No se encontró el contacto de emergencia.', details: {} });
    return { id, deleted: true };
  }

  async createShareMessage(user: AuthenticatedUser, dto: ShareEmergencyMessageDto): Promise<Record<string, unknown>> {
    const [profile, vehicle] = await Promise.all([
      this.prisma.user.findFirst({ where: { id: user.id, status: 'active', deletedAt: null }, select: {
        id: true, displayName: true, phoneCiphertext: true, phoneNonce: true, phoneTag: true,
        phoneEncryptedDek: true, phoneKeyVersion: true,
      } }),
      this.prisma.vehicle.findFirst({ where: { id: dto.vehicle_id, userId: user.id, deletedAt: null }, select: {
        id: true, nickname: true, brandLabel: true, modelLabel: true, modelYear: true, vehicleType: true,
      } }),
    ]);
    if (!profile) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'No se encontró una cuenta activa.', details: {} });
    if (!vehicle) throw new NotFoundException({ code: 'VEHICLE_NOT_FOUND', message: 'No se encontró el vehículo seleccionado.', details: {} });
    if (!profile.phoneCiphertext || !profile.phoneNonce || !profile.phoneTag || !profile.phoneEncryptedDek || !profile.phoneKeyVersion) {
      throw new ConflictException({ code: 'USER_PHONE_UNAVAILABLE', message: 'Registra un teléfono en tu cuenta antes de compartir una solicitud de emergencia.', details: {} });
    }
    const phone = await this.crypto.decrypt({
      ciphertext: Buffer.from(profile.phoneCiphertext), nonce: Buffer.from(profile.phoneNonce),
      tag: Buffer.from(profile.phoneTag), encryptedDek: Buffer.from(profile.phoneEncryptedDek),
      keyVersion: profile.phoneKeyVersion, aadVersion: 1,
    }, 'users.phone');

    const mapUrl = `https://www.google.com/maps/search/?api=1&query=${dto.latitude.toFixed(6)},${dto.longitude.toFixed(6)}`;
    const makeModel = [vehicle.brandLabel, vehicle.modelLabel].filter((value): value is string => Boolean(value?.trim())).join(' ');
    const vehicleLabel = [vehicle.nickname, makeModel, vehicle.modelYear ? String(vehicle.modelYear) : null]
      .filter((value): value is string => Boolean(value?.trim())).join(' · ') || vehicle.vehicleType;
    const message = [
      'SOLICITUD DE ASISTENCIA VIAL',
      `Nombre: ${profile.displayName}`,
      `Teléfono: ${phone}`,
      `Vehículo: ${vehicleLabel} (${vehicle.vehicleType})`,
      `Ubicación: ${mapUrl}`,
      `Referencia: ${dto.reference.trim()}`,
    ].join('\n');
    return {
      message,
      map_url: mapUrl,
      whatsapp_url: `https://wa.me/?text=${encodeURIComponent(message)}`,
      generated_at: new Date().toISOString(),
    };
  }

  private async serializeContact(row: {
    id: string; userId: string; name: string; relationshipLabel: string | null; isPrimary: boolean;
    phoneCiphertext: Uint8Array | null; phoneNonce: Uint8Array | null; phoneTag: Uint8Array | null;
    phoneEncryptedDek: Uint8Array | null; phoneKeyVersion: string | null; phoneAadVersion: number | null;
    createdAt: Date; updatedAt: Date; deletedAt: Date | null; syncVersion: bigint;
  }): Promise<Record<string, unknown>> {
    const aadVersion = row.phoneAadVersion ?? 1;
    const phone = row.phoneCiphertext && row.phoneNonce && row.phoneTag && row.phoneEncryptedDek && row.phoneKeyVersion
      ? await this.crypto.decrypt({
          ciphertext: Buffer.from(row.phoneCiphertext), nonce: Buffer.from(row.phoneNonce),
          tag: Buffer.from(row.phoneTag), encryptedDek: Buffer.from(row.phoneEncryptedDek),
          keyVersion: row.phoneKeyVersion, aadVersion,
        }, 'emergency_contacts.phone', aadVersion >= 2 ? { userId: row.userId, recordId: row.id } : undefined)
      : null;
    return { id: row.id, name: row.name, relationship_label: row.relationshipLabel, phone_e164: phone, is_primary: row.isPrimary,
      created_at: row.createdAt, updated_at: row.updatedAt, deleted_at: row.deletedAt,
      sync_version: row.syncVersion.toString() };
  }

  private isMaxContactsDbError(error: unknown): boolean {
    return error instanceof Error && (error.message.includes('chk_emergency_contacts_max_five') || error.message.includes('maximo cinco contactos'));
  }
}
