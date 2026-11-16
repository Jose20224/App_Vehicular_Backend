import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../redis/redis.service';

export type CatalogName =
  | 'vehicle-brands' | 'vehicle-models' | 'insurers' | 'emergency-numbers'
  | 'service-types' | 'specialties' | 'departments' | 'municipalities';

export interface EmergencyNumberInput {
  label?: string;
  category?: string;
  phone_number?: string;
  department_id?: string | null;
  municipality_id?: string | null;
  source_name?: string | null;
  source_url?: string | null;
  verified?: boolean;
  notes?: string | null;
  is_active?: boolean;
}

const CATALOGS: CatalogName[] = [
  'vehicle-brands', 'vehicle-models', 'insurers', 'emergency-numbers',
  'service-types', 'specialties', 'departments', 'municipalities',
];

@Injectable()
export class CatalogsService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly redis?: RedisService,
  ) {}

  async getCatalog(name: string, filters: { brandId?: string; departmentId?: string } = {}): Promise<{
    catalog: CatalogName; catalogVersion: string; etag: string; items: Array<Record<string, unknown>>;
  }> {
    if (!CATALOGS.includes(name as CatalogName)) throw new NotFoundException({
      code: 'CATALOG_NOT_FOUND', message: 'El catálogo solicitado no existe.', details: { catalog: name },
    });
    const catalog = name as CatalogName;
    const { brandId, departmentId } = filters;
    if (brandId && !this.isUuid(brandId)) throw this.invalidFilter('brand_id');
    if (departmentId && !this.isUuid(departmentId)) throw this.invalidFilter('department_id');
    if (brandId && catalog !== 'vehicle-models') throw this.unsupportedFilter('brand_id');
    if (departmentId && catalog !== 'municipalities') throw this.unsupportedFilter('department_id');

    const versionRow = await this.prisma.catalogVersion.findUnique({ where: { catalogName: catalog } });
    const version = versionRow?.version ?? 0n;
    const filterKey = `${brandId ?? 'all'}:${departmentId ?? 'all'}`;
    // Los recursos filtrados requieren ETags distintos para evitar 304 incorrectos
    // al cambiar de marca/departamento conservando el mismo número de versión.
    const filterTag = brandId || departmentId
      ? `-${createHash('sha256').update(filterKey).digest('hex').slice(0, 12)}`
      : '';
    const etag = `"${catalog}-${version.toString()}${filterTag}"`;
    const cacheKey = `catalogs:v1:${catalog}:${version.toString()}:${filterKey}`;
    const cached = await this.cacheGet(cacheKey);
    if (cached) return { ...cached, etag };

    let items: Array<Record<string, unknown>> = [];
    switch (catalog) {
      case 'vehicle-brands': {
        const rows = await this.prisma.vehicleBrand.findMany({
          where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { normalizedName: 'asc' }],
          select: { id: true, name: true, sortOrder: true },
        });
        items = rows.map((row) => ({ id: row.id, name: row.name, sort_order: row.sortOrder }));
        break;
      }
      case 'vehicle-models': {
        const rows = await this.prisma.vehicleModel.findMany({
          where: { isActive: true, ...(brandId ? { brandId } : {}) },
          orderBy: [{ brandId: 'asc' }, { normalizedName: 'asc' }],
          select: { id: true, brandId: true, name: true, vehicleCategory: true },
        });
        items = rows.map((row) => ({ id: row.id, brand_id: row.brandId, name: row.name, vehicle_category: row.vehicleCategory }));
        break;
      }
      case 'insurers': {
        const rows = await this.prisma.insurer.findMany({
          where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { normalizedName: 'asc' }],
          select: { id: true, name: true },
        });
        items = rows.map((row) => ({ id: row.id, name: row.name }));
        break;
      }
      case 'emergency-numbers': {
        const rows = await this.prisma.emergencyNumber.findMany({
          where: { isActive: true, verified: true },
          orderBy: [{ category: 'asc' }, { label: 'asc' }],
          select: { id: true, label: true, category: true, phoneNumber: true, sourceName: true,
            sourceUrl: true, verified: true, verifiedAt: true, department: { select: { id: true, name: true } },
            municipality: { select: { id: true, name: true } } },
        });
        items = rows.map((row) => ({
          id: row.id, label: row.label, category: row.category, phone_number: row.phoneNumber,
          source_name: row.sourceName, source_url: row.sourceUrl, verified: row.verified,
          verified_at: row.verifiedAt, department: row.department, municipality: row.municipality,
        }));
        break;
      }
      case 'service-types': {
        const rows = await this.prisma.serviceType.findMany({
          where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          select: { id: true, code: true, name: true, description: true, isEmergency: true, sortOrder: true },
        });
        items = rows.map((row) => ({ id: row.id, code: row.code, name: row.name, description: row.description,
          is_emergency: row.isEmergency, sort_order: row.sortOrder }));
        break;
      }
      case 'specialties': {
        const rows = await this.prisma.specialty.findMany({
          where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          select: { id: true, code: true, name: true, description: true, sortOrder: true },
        });
        items = rows.map((row) => ({ id: row.id, code: row.code, name: row.name, description: row.description, sort_order: row.sortOrder }));
        break;
      }
      case 'departments': {
        const rows = await this.prisma.department.findMany({
          where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          select: { id: true, code: true, name: true, administrativeType: true },
        });
        items = rows.map((row) => ({ id: row.id, code: row.code, name: row.name, administrative_type: row.administrativeType }));
        break;
      }
      case 'municipalities': {
        const rows = await this.prisma.municipality.findMany({
          where: { isActive: true, ...(departmentId ? { departmentId } : {}) },
          orderBy: [{ department: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { name: 'asc' }],
          select: { id: true, code: true, name: true, departmentId: true, department: { select: { code: true, name: true } } },
        });
        items = rows.map((row) => ({ id: row.id, code: row.code, name: row.name,
          department_id: row.departmentId, department_code: row.department.code, department_name: row.department.name }));
        break;
      }
    }

    const result = { catalog, catalogVersion: version.toString(), etag, items };
    await this.cacheSet(cacheKey, { catalog, catalogVersion: version.toString(), items });
    return result;
  }

  /** Compatibilidad para pruebas y consumidores internos anteriores a B5. */
  getVehicleCatalog(name: string, brandId?: string) {
    return this.getCatalog(name, { brandId });
  }

  async getCatalogStatus(): Promise<{ etag: string; catalogs: Record<string, { version: string; etag: string; updated_at: Date | null }> }> {
    const rows = await this.prisma.catalogVersion.findMany({ where: { catalogName: { in: CATALOGS } }, orderBy: { catalogName: 'asc' } });
    const byName = new Map(rows.map((row) => [row.catalogName, row]));
    const catalogs: Record<string, { version: string; etag: string; updated_at: Date | null }> = {};
    for (const name of CATALOGS) {
      const row = byName.get(name);
      const version = row?.version ?? 0n;
      catalogs[name] = { version: version.toString(), etag: `"${name}-${version.toString()}"`, updated_at: row?.updatedAt ?? null };
    }
    const digest = createHash('sha256').update(JSON.stringify(Object.fromEntries(
      Object.entries(catalogs).map(([key, value]) => [key, value.version]),
    ))).digest('hex').slice(0, 24);
    return { etag: `"catalog-status-${digest}"`, catalogs };
  }

  async listEmergencyNumbers(includeInactive = true): Promise<Array<Record<string, unknown>>> {
    const rows = await this.prisma.emergencyNumber.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ category: 'asc' }, { label: 'asc' }],
    });
    return rows.map((row) => ({
      id: row.id, label: row.label, category: row.category, phone_number: row.phoneNumber,
      department_id: row.departmentId, municipality_id: row.municipalityId,
      source_name: row.sourceName, source_url: row.sourceUrl, verified: row.verified,
      verified_at: row.verifiedAt, verified_by_user_id: row.verifiedByUserId,
      notes: row.notes, is_active: row.isActive, created_at: row.createdAt, updated_at: row.updatedAt,
    }));
  }

  async createEmergencyNumber(dto: EmergencyNumberInput, adminUserId: string): Promise<Record<string, unknown>> {
    this.validateEmergencyPhone(dto.phone_number!);
    await this.validateEmergencyLocation(dto.department_id ?? null, dto.municipality_id ?? null);
    if (dto.verified === true && !dto.source_name?.trim()) throw new BadRequestException({
      code: 'EMERGENCY_VERIFICATION_SOURCE_REQUIRED',
      message: 'Para verificar un número debes registrar la fuente oficial que lo confirma.', details: {},
    });
    const row = await this.prisma.emergencyNumber.create({
      data: {
        label: dto.label!.trim(), category: dto.category!.trim(), phoneNumber: dto.phone_number!.trim(),
        departmentId: dto.department_id ?? null, municipalityId: dto.municipality_id ?? null,
        sourceName: dto.source_name?.trim() || null, sourceUrl: dto.source_url ?? null,
        verified: dto.verified ?? false, verifiedAt: dto.verified ? new Date() : null,
        verifiedByUserId: dto.verified ? adminUserId : null, notes: dto.notes ?? null,
        isActive: dto.is_active ?? true,
      },
    });
    return this.serializeEmergencyNumber(row);
  }

  async updateEmergencyNumber(id: string, dto: EmergencyNumberInput, adminUserId: string): Promise<Record<string, unknown>> {
    const existing = await this.prisma.emergencyNumber.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException({ code: 'EMERGENCY_NUMBER_NOT_FOUND', message: 'No se encontró el número de emergencia.', details: {} });
    const phoneChanged = dto.phone_number !== undefined && dto.phone_number.trim() !== existing.phoneNumber;
    const departmentChanged = dto.department_id !== undefined && dto.department_id !== existing.departmentId;
    const municipalityChanged = dto.municipality_id !== undefined && dto.municipality_id !== existing.municipalityId;
    const categoryChanged = dto.category !== undefined && dto.category.trim() !== existing.category;
    const sourceNameChanged = dto.source_name !== undefined && (dto.source_name?.trim() || null) !== existing.sourceName;
    const sourceUrlChanged = dto.source_url !== undefined && dto.source_url !== existing.sourceUrl;
    const verificationInvalidated = phoneChanged || departmentChanged || municipalityChanged || categoryChanged
      || sourceNameChanged || sourceUrlChanged;
    const verified = dto.verified ?? (verificationInvalidated ? false : existing.verified);
    const sourceName = dto.source_name === undefined
      ? (verificationInvalidated ? null : existing.sourceName)
      : (dto.source_name?.trim() || null);
    if (verified && !sourceName) throw new BadRequestException({
      code: 'EMERGENCY_VERIFICATION_SOURCE_REQUIRED',
      message: 'Para verificar un número debes registrar la fuente oficial que lo confirma.', details: {},
    });
    if (dto.phone_number !== undefined) this.validateEmergencyPhone(dto.phone_number);
    const municipalityId = dto.municipality_id === undefined ? existing.municipalityId : dto.municipality_id;
    const departmentId = dto.department_id === undefined ? existing.departmentId : dto.department_id;
    await this.validateEmergencyLocation(departmentId, municipalityId);
    const row = await this.prisma.$transaction(async (tx) => {
      // El primer UPDATE activa el trigger de invalidación, también para cambios
      // hechos desde SQL. La revalidación explícita ocurre en un segundo UPDATE.
      const updated = await tx.emergencyNumber.update({
        where: { id },
        data: {
          ...(dto.label !== undefined ? { label: dto.label.trim() } : {}),
          ...(dto.category !== undefined ? { category: dto.category.trim() } : {}),
          ...(dto.phone_number !== undefined ? { phoneNumber: dto.phone_number.trim() } : {}),
          ...(dto.department_id !== undefined ? { departmentId: dto.department_id } : {}),
          ...(dto.municipality_id !== undefined ? { municipalityId: dto.municipality_id } : {}),
          ...(dto.source_name !== undefined ? { sourceName } : verificationInvalidated && dto.verified !== true ? { sourceName: null } : {}),
          ...(dto.source_url !== undefined ? { sourceUrl: dto.source_url } : verificationInvalidated ? { sourceUrl: null } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(dto.is_active !== undefined ? { isActive: dto.is_active } : {}),
          updatedAt: new Date(),
          ...(dto.verified === false || (verificationInvalidated && dto.verified !== true) ? {
            verified: false, verifiedAt: null, verifiedByUserId: null,
          } : {}),
        },
      });
      if (dto.verified === true) {
        return tx.emergencyNumber.update({
          where: { id },
          // No modificar source_name/source_url aquí: el primer UPDATE ya los
          // guardó y el trigger invalidó la verificación anterior. Este segundo
          // UPDATE solo registra la nueva verificación explícita del admin.
          data: { verified: true, verifiedAt: new Date(), verifiedByUserId: adminUserId },
        });
      }
      return updated;
    });
    return this.serializeEmergencyNumber(row);
  }

  async deactivateEmergencyNumber(id: string): Promise<{ id: string; is_active: false }> {
    const updated = await this.prisma.emergencyNumber.updateMany({ where: { id, isActive: true }, data: { isActive: false, updatedAt: new Date() } });
    if (updated.count !== 1) throw new NotFoundException({ code: 'EMERGENCY_NUMBER_NOT_FOUND', message: 'No se encontró un número de emergencia activo.', details: {} });
    return { id, is_active: false };
  }

  private serializeEmergencyNumber(row: {
    id: string; label: string; category: string; phoneNumber: string; verified: boolean;
    verifiedAt: Date | null; sourceName: string | null; isActive: boolean; updatedAt: Date;
  }): Record<string, unknown> {
    return { id: row.id, label: row.label, category: row.category, phone_number: row.phoneNumber,
      source_name: row.sourceName, verified: row.verified, verified_at: row.verifiedAt,
      is_active: row.isActive, updated_at: row.updatedAt };
  }

  private async cacheGet(key: string): Promise<{ catalog: CatalogName; catalogVersion: string; items: Array<Record<string, unknown>> } | null> {
    if (!this.redis) return null;
    try {
      const value = await this.redis.client.get(key);
      if (!value) return null;
      const parsed = JSON.parse(value) as { catalog: CatalogName; catalogVersion: string; items: Array<Record<string, unknown>> };
      return parsed && Array.isArray(parsed.items) ? parsed : null;
    } catch { return null; }
  }

  private async cacheSet(key: string, value: unknown): Promise<void> {
    if (!this.redis) return;
    try { await this.redis.client.set(key, JSON.stringify(value), 'EX', 3600); } catch { /* Cache es opcional; PostgreSQL sigue siendo fuente de verdad. */ }
  }

  private async validateEmergencyLocation(departmentId: string | null, municipalityId: string | null): Promise<void> {
    if (municipalityId && !departmentId) throw new BadRequestException({
      code: 'MUNICIPALITY_REQUIRES_DEPARTMENT', message: 'Una ubicación municipal requiere departamento o región.', details: {},
    });
    if (departmentId) {
      const department = await this.prisma.department.findUnique({ where: { id: departmentId }, select: { id: true } });
      if (!department) throw new BadRequestException({
        code: 'EMERGENCY_DEPARTMENT_INVALID', message: 'El departamento o región indicado no existe.', details: {},
      });
    }
    if (municipalityId) {
      const municipality = await this.prisma.municipality.findFirst({
        where: { id: municipalityId, departmentId: departmentId! }, select: { id: true },
      });
      if (!municipality) throw new BadRequestException({
        code: 'EMERGENCY_MUNICIPALITY_INVALID', message: 'El municipio no pertenece al departamento o región seleccionado.', details: {},
      });
    }
  }

  private validateEmergencyPhone(phone: string): void {
    if (!/^(\+[1-9][0-9]{7,14}|[0-9]{3,10})$/.test(phone.trim())) throw new BadRequestException({
      code: 'EMERGENCY_PHONE_INVALID', message: 'El número debe ser E.164 o un número corto nacional de hasta 10 dígitos.', details: {},
    });
  }

  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }
  private invalidFilter(name: string): BadRequestException {
    return new BadRequestException({ code: 'CATALOG_FILTER_INVALID', message: `${name} debe ser un UUID válido.`, details: {} });
  }
  private unsupportedFilter(name: string): BadRequestException {
    return new BadRequestException({ code: 'CATALOG_FILTER_NOT_SUPPORTED', message: `El catálogo no acepta el filtro ${name}.`, details: {} });
  }
}
