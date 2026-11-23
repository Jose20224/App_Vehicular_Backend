import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { RESOURCE_OWNER, type OwnedResource } from '../decorators/resource-owner.decorator';
import type { AuthenticatedUser } from '../decorators/current-user.decorator';

const RESOURCE_TABLES: Record<OwnedResource, string> = {
  vehicle: 'vehicles',
  vehicle_document: 'vehicle_documents',
  insurance_policy: 'insurance_policies',
  workshop: 'workshops',
  assistance_provider: 'assistance_providers',
  assistance_request: 'assistance_requests',
};

@Injectable()
export class ResourceOwnerGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const metadata = this.reflector.get<{ resource: OwnedResource; idParam: string }>(
      RESOURCE_OWNER,
      context.getHandler(),
    );
    if (!metadata) return true;

    const request = context.switchToHttp().getRequest<{
      params: Record<string, string>;
      user?: AuthenticatedUser;
    }>();
    const id = request.params[metadata.idParam];
    const userId = request.user?.id;
    const table = RESOURCE_TABLES[metadata.resource];
    if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) || !userId || !table) throw new NotFoundException({
      code: 'RESOURCE_NOT_FOUND',
      message: 'No se encontró el recurso solicitado.',
      details: {},
    });

    const rows = await this.prisma.$queryRaw<Array<{ owned: boolean }>>(Prisma.sql`
      SELECT EXISTS (
        SELECT 1 FROM public.${Prisma.raw(`"${table}"`)}
        WHERE id = ${id}::uuid AND user_id = ${userId}::uuid AND deleted_at IS NULL
      ) AS owned
    `);
    if (!rows[0]?.owned) throw new NotFoundException({
      code: 'RESOURCE_NOT_FOUND',
      message: 'No se encontró el recurso solicitado.',
      details: {},
    });
    return true;
  }
}
