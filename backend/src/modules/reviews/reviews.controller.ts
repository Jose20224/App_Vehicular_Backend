import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CreateReviewDto } from './dto/create-review.dto';
import { CreateReviewReportDto } from './dto/create-review-report.dto';
import { CreateReviewReplyDto } from './dto/create-review-reply.dto';
import { ListReviewsQueryDto } from './dto/list-reviews-query.dto';
import { ReviewsService } from './reviews.service';

@ApiTags('Reseñas y calificaciones')
@Controller()
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Public()
  @Get('workshops/:workshopId/reviews')
  @ApiOperation({ summary: 'Listar reseñas publicadas y respuestas visibles de un taller.' })
  listWorkshopReviews(@Param('workshopId') workshopId: string, @Query() query: ListReviewsQueryDto) {
    return this.reviews.listPublicReviews(workshopId, query);
  }

  @Post('reviews')
  @Roles('user')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @ApiCreatedResponse({ description: 'Crea una reseña pendiente de moderación. Un usuario puede reseñar el mismo taller una vez cada seis meses.' })
  @ApiOperation({ summary: 'Crear una reseña autenticada de un taller.' })
  createReview(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateReviewDto) {
    return this.reviews.createReview(user.id, dto);
  }

  @Post('reviews/:reviewId/reports')
  @Roles('user', 'workshop_owner')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @ApiCreatedResponse({ description: 'Reporta una reseña con motivo. El dueño solo puede reportar reseñas de su propio taller.' })
  @ApiOperation({ summary: 'Reportar una reseña como usuario o propietario del taller.' })
  reportReview(@CurrentUser() user: AuthenticatedUser, @Param('reviewId') reviewId: string, @Body() dto: CreateReviewReportDto) {
    return this.reviews.reportReview(user, reviewId, dto);
  }

  @Post('workshops/:workshopId/reviews/:reviewId/reply')
  @Roles('workshop_owner')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @ApiCreatedResponse({ description: 'Publica la única respuesta del propietario a una reseña publicada de su propio taller.' })
  @ApiOperation({ summary: 'Responder una reseña. No existe endpoint de propietario para ocultar, editar, borrar ni ordenar reseñas.' })
  replyToReview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workshopId') workshopId: string,
    @Param('reviewId') reviewId: string,
    @Body() dto: CreateReviewReplyDto,
  ) {
    return this.reviews.replyToReview(user.id, workshopId, reviewId, dto);
  }
}
