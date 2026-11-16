import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AdsService } from './ads.service';
import { CreateAdCampaignDto, RecordAdMetricDto, ServeAdsQueryDto, UpsertAdPlanDto, UpsertAdSlotDto } from './dto/ads.dto';

@ApiTags('Publicidad')
@Controller('ads')
export class AdsController {
  constructor(private readonly ads: AdsService) {}

  @Public() @Get('plans')
  @ApiOperation({ summary: 'Consultar planes B2B disponibles en USD y su equivalente informativo en NIO.' })
  plans() { return this.ads.listPlans(); }

  @Public() @Get('serve')
  @ApiOperation({ summary: 'Servir anuncios vigentes por espacio y ubicación.' })
  serve(@Query() query: ServeAdsQueryDto) { return this.ads.serve(query); }

  @Post('campaigns') @Roles('workshop_owner', 'provider_owner') @HttpCode(HttpStatus.CREATED) @ApiBearerAuth()
  createCampaign(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateAdCampaignDto) {
    return this.ads.createCampaign(user.id, user.role as 'workshop_owner' | 'provider_owner', dto);
  }

  @Get('campaigns/mine') @Roles('workshop_owner', 'provider_owner') @ApiBearerAuth()
  campaigns(@CurrentUser() user: AuthenticatedUser) { return this.ads.listMyCampaigns(user.id); }

  @Post('campaigns/:id/submit') @Roles('workshop_owner', 'provider_owner') @ApiBearerAuth()
  submit(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) { return this.ads.submitCampaign(user.id, id); }

  @Post('campaigns/:id/pause') @Roles('workshop_owner', 'provider_owner') @ApiBearerAuth()
  pause(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) { return this.ads.pauseCampaign(user.id, id); }

  @Post('campaigns/:id/cancel') @Roles('workshop_owner', 'provider_owner') @ApiBearerAuth()
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) { return this.ads.cancelCampaign(user.id, id); }

  @Post('campaigns/:id/confirm-payment') @Roles('admin') @ApiBearerAuth()
  confirmPayment(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) { return this.ads.confirmPayment(user.id, id); }

  @Post('metrics') @Roles('user') @HttpCode(HttpStatus.ACCEPTED) @ApiBearerAuth()
  metric(@CurrentUser() user: AuthenticatedUser, @Body() dto: RecordAdMetricDto) { return this.ads.recordMetric(user.id, dto); }

  @Get('campaigns/:id/report') @Roles('workshop_owner', 'provider_owner', 'admin') @ApiBearerAuth()
  report(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.ads.report(user.role === 'admin' ? undefined : user.id, id, from, to);
  }

  @Post('admin/plans') @Roles('admin') @ApiBearerAuth()
  upsertPlan(@Body() dto: UpsertAdPlanDto) { return this.ads.upsertPlan(dto); }

  @Post('admin/slots') @Roles('admin') @ApiBearerAuth()
  upsertSlot(@Body() dto: UpsertAdSlotDto) { return this.ads.upsertSlot(dto); }
}
