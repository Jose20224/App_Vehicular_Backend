import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ModerateReviewDto } from './dto/moderate-review.dto';
import { ResolveReviewReportDto } from './dto/resolve-review-report.dto';
import { ReviewsService } from './reviews.service';

@ApiTags('Administración · Moderación de reseñas')
@ApiBearerAuth()
@Roles('admin')
@Controller('admin/reviews')
export class ReviewsAdminController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get('moderation-queue')
  @ApiOperation({ summary: 'Consultar reseñas pendientes; prioriza contenido señalado por el filtro automático.' })
  moderationQueue(@Query('limit') limit?: string) {
    return this.reviews.listModerationQueue(limit);
  }

  @Patch(':reviewId/moderation')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Aprobar, rechazar o retirar una reseña. Solo admin; los promedios se actualizan dentro de la misma transacción.' })
  moderate(@CurrentUser() user: AuthenticatedUser, @Param('reviewId') reviewId: string, @Body() dto: ModerateReviewDto) {
    return this.reviews.moderateReview(user.id, reviewId, dto);
  }

  @Get('reports')
  @ApiOperation({ summary: 'Listar reportes de reseñas pendientes o resueltos.' })
  listReports(@Query('status') status?: string, @Query('limit') limit?: string) {
    return this.reviews.listReports(status, limit);
  }

  @Patch('reports/:reportId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resolver o descartar un reporte. Solo admin.' })
  resolveReport(@CurrentUser() user: AuthenticatedUser, @Param('reportId') reportId: string, @Body() dto: ResolveReviewReportDto) {
    return this.reviews.resolveReport(user.id, reportId, dto.status);
  }
}
