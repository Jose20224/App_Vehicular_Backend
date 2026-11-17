import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { from, mergeMap, Observable } from 'rxjs';

interface AdminRequest {
  method: string;
  path: string;
  originalUrl?: string;
  params?: Record<string, string>;
  user?: { id?: string; role?: string };
  body?: Record<string, unknown>;
}

const TABLES: Record<string, string> = {
  workshop: 'workshops', provider: 'assistance_providers', review: 'reviews', review_report: 'review_reports',
  emergency_number: 'emergency_numbers', ad_payment: 'ad_payments', ad_plan: 'ad_plans', ad_slot: 'ad_slots',
  business_claim: 'business_claims',
  'vehicle-brands': 'vehicle_brands', 'vehicle-models': 'vehicle_models', insurers: 'insurers',
  'service-types': 'service_types', specialties: 'specialties', departments: 'departments', municipalities: 'municipalities',
};

@Injectable()
export class AdminAuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AdminAuditInterceptor.name);
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<AdminRequest>();
    if (req.user?.role !== 'admin' || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method.toUpperCase())) return next.handle();
    const path = req.path ?? req.originalUrl ?? 'unknown';
    const target = this.target(path, req.params ?? {}, req.body ?? {});
    const before$ = target.id && target.table
      ? from(this.readBefore(target.table, target.id, target.keyColumn ?? 'id'))
      : from(Promise.resolve(null));
    return before$.pipe(mergeMap((before) => next.handle().pipe(mergeMap((result) => from(this.writeAudit({
      actorId: req.user!.id!, action: `${req.method.toUpperCase()} ${path}`, resourceType: target.type,
      resourceId: target.id ?? null, beforeState: scrub(before), afterState: scrub(result),
    })).pipe(mergeMap(() => from(Promise.resolve(result))))))));
  }

  private async readBefore(table: string, id: string, keyColumn: 'id' | 'code' = 'id'): Promise<unknown> {
    const safeTable = TABLES[table];
    if (!safeTable || (keyColumn === 'id' && !/^[0-9a-f-]{36}$/i.test(id))) return null;
    const rows = keyColumn === 'code'
      ? await this.prisma.$queryRaw<Array<{ data: unknown }>>(Prisma.sql`SELECT to_jsonb(t) AS data FROM public.${Prisma.raw(safeTable)} t WHERE code = ${id}`)
      : await this.prisma.$queryRaw<Array<{ data: unknown }>>(Prisma.sql`SELECT to_jsonb(t) AS data FROM public.${Prisma.raw(safeTable)} t WHERE id = ${id}::uuid`);
    return rows[0]?.data ?? null;
  }

  private async writeAudit(input: { actorId: string; action: string; resourceType: string; resourceId: string | null; beforeState: unknown; afterState: unknown }): Promise<void> {
    try {
      await this.prisma.adminAuditLog.create({ data: {
        actorUserId: input.actorId, action: input.action.slice(0, 180), resourceType: input.resourceType,
        resourceId: input.resourceId?.slice(0, 100) ?? null,
        beforeState: input.beforeState as Prisma.InputJsonValue ?? {},
        afterState: input.afterState as Prisma.InputJsonValue ?? {},
      } });
    } catch (error) {
      this.logger.error('No fue posible guardar la auditoría administrativa.');
      throw error;
    }
  }

  private target(path: string, params: Record<string, string>, body: Record<string, unknown>): { type: string; table?: string; id?: string; keyColumn?: 'id' | 'code' } {
    const matches: Array<[RegExp, string, string]> = [
      [/\/workshops\/([^/]+)\/status$/, 'workshop', 'id'],
      [/\/assistance-providers\/([^/]+)\/status$/, 'provider', 'id'],
      [/\/admin\/reviews\/([^/]+)\/moderation$/, 'review', 'reviewId'],
      [/\/admin\/reviews\/reports\/([^/]+)$/, 'review_report', 'reportId'],
      [/\/admin\/emergency-numbers\/([^/]+)$/, 'emergency_number', 'id'],
      [/\/ads\/admin\/payments\/([^/]+)\/(?:approve|reject)$/, 'ad_payment', 'id'],
      [/\/admin\/business-claims\/([^/]+)$/, 'business_claim', 'id'],
    ];
    for (const [pattern, type, param] of matches) {
      const match = path.match(pattern);
      if (match) return { type, table: type, id: param ? params[param] ?? match[1] : undefined };
    }
    if (/\/ads\/admin\/plans$/.test(path) && typeof body.code === 'string') return { type: 'ad_plan', table: 'ad_plan', id: body.code, keyColumn: 'code' };
    if (/\/ads\/admin\/slots$/.test(path) && typeof body.code === 'string') return { type: 'ad_slot', table: 'ad_slot', id: body.code, keyColumn: 'code' };
    if (/\/admin\/catalogs\/active$/.test(path) && typeof body.catalog === 'string' && typeof body.item_id === 'string') return { type: body.catalog, table: body.catalog, id: body.item_id };
    return { type: path.split('/').filter(Boolean).slice(-2, -1)[0] ?? 'admin_action' };
  }
}

function scrub(value: unknown): Prisma.InputJsonValue | null {
  if (value === null || value === undefined) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item)); }
  catch { return { unavailable: true }; }
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) =>
      [key, /phone|email|ciphertext|nonce|encrypteddek|hmac|token|password/i.test(key) ? '[redacted]' : visit(child)]));
    return item;
  };
  return visit(parsed) as Prisma.InputJsonValue;
}
