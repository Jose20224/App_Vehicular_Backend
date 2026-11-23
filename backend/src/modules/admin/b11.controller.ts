import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../database/prisma.service';
import { B11BackofficeService } from './b11-backoffice.service';
import { CatalogActiveDto, BulkEmergencyCsvDto, ReviewBusinessClaimDto } from './b11.dto';

@ApiTags('Backoffice B11')
@ApiBearerAuth()
@Roles('admin')
@Controller('admin')
export class B11AdminController {
  constructor(private readonly service: B11BackofficeService, private readonly prisma: PrismaService) {}

  @Get('dashboard') dashboard() { return this.service.dashboard(); }
  @Post('imports/emergency-numbers-csv') importEmergency(@CurrentUser() user: AuthenticatedUser, @Body() dto: BulkEmergencyCsvDto) { return this.service.importEmergencyCsv(user.id, dto.csv); }
  @Get('business-claims') claims(@Query('status') status?: string) { return this.service.listClaims(status); }
  @Patch('business-claims/:id') reviewClaim(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: ReviewBusinessClaimDto) { return this.service.reviewClaim(user.id, id, dto.decision, dto.reason); }
  @Patch('catalogs/active') setCatalogActive(@CurrentUser() user: AuthenticatedUser, @Body() dto: CatalogActiveDto) { return this.service.setCatalogActive(user.id, dto.catalog, dto.item_id, dto.is_active === 'true'); }
  @Get('audit-logs') async auditLogs(@Query('limit') input?: string) {
    const limit = Math.max(1, Math.min(Number(input) || 50, 200));
    const rows = await this.prisma.adminAuditLog.findMany({ take: limit, orderBy: { createdAt: 'desc' }, include: { actor: { select: { id: true, displayName: true } } } });
    return { items: rows.map((r) => ({ id: r.id, actor: r.actor, action: r.action, resource_type: r.resourceType, resource_id: r.resourceId, before: r.beforeState, after: r.afterState, created_at: r.createdAt.toISOString() })), count: rows.length };
  }
}

@ApiTags('Reclamaciones de negocios')
@ApiBearerAuth()
@Controller('business-claims')
export class BusinessClaimsController {
  constructor(private readonly service: B11BackofficeService) {}
  @Post('workshops') @Roles('workshop_owner') claimWorkshop(@CurrentUser() user: AuthenticatedUser, @Body() dto: import('./b11.dto').CreateBusinessClaimDto) { return this.service.claim(user.id, 'workshop', dto.business_id, dto.evidence); }
  @Post('providers') @Roles('provider_owner') claimProvider(@CurrentUser() user: AuthenticatedUser, @Body() dto: import('./b11.dto').CreateBusinessClaimDto) { return this.service.claim(user.id, 'provider', dto.business_id, dto.evidence); }
}
