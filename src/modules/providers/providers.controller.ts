import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CreateAssistanceProviderDto } from './dto/create-assistance-provider.dto';
import { UpdateAssistanceProviderDto } from './dto/update-assistance-provider.dto';
import { SearchAssistanceProvidersQueryDto } from './dto/search-assistance-providers-query.dto';
import { ProviderStatusDto } from './dto/provider-status.dto';
import { CreateAssistanceRequestDto } from './dto/create-assistance-request.dto';
import { AssistanceHistoryQueryDto } from './dto/history-query.dto';
import { ProvidersService } from './providers.service';

@ApiTags('Proveedores de asistencia vial')
@Controller()
export class ProvidersController {
  constructor(private readonly providers: ProvidersService) {}

  @Public()
  @Get('assistance-providers/search')
  @ApiOperation({ summary: 'Buscar proveedores verificados que cubren una ubicación; prioriza disponibilidad y cercanía.' })
  search(@Query() query: SearchAssistanceProvidersQueryDto) { return this.providers.searchProviders(query); }

  @Public()
  @Get('assistance-providers/offline-emergency-package')
  @ApiOperation({ summary: 'Paquete compacto de emergencia por GPS; el cliente puede guardarlo por siete días.' })
  offlinePackage(@Query() query: SearchAssistanceProvidersQueryDto) { return this.providers.getOfflineEmergencyPackage(query); }

  @Get('assistance-providers/mine')
  @Roles('provider_owner') @ApiBearerAuth()
  @ApiOperation({ summary: 'Listar perfiles de proveedores propios.' })
  mine(@CurrentUser() user: AuthenticatedUser) { return this.providers.getOwnedProviders(user.id); }

  @Get('assistance-providers/mine/:id')
  @Roles('provider_owner') @ApiBearerAuth()
  @ApiOperation({ summary: 'Obtener un perfil propio, con teléfono descifrado solo para su titular.' })
  mineDetail(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) { return this.providers.getOwnedProvider(user.id, id); }

  @Post('assistance-providers')
  @Roles('provider_owner') @ApiBearerAuth() @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crear un perfil de proveedor con contacto cifrado y cobertura GeoJSON.' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateAssistanceProviderDto) { return this.providers.createProvider(user.id, dto); }

  @Patch('assistance-providers/:id')
  @Roles('provider_owner') @ApiBearerAuth()
  @ApiOperation({ summary: 'Actualizar el perfil, los contactos o el polígono de cobertura.' })
  update(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdateAssistanceProviderDto) {
    return this.providers.updateProvider(user.id, id, dto);
  }

  @Post('assistance-providers/:id/submit-verification')
  @Roles('provider_owner') @ApiBearerAuth()
  @ApiOperation({ summary: 'Enviar el perfil completo a verificación administrativa.' })
  submit(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) { return this.providers.submitProviderForVerification(user.id, id); }

  @Patch('admin/assistance-providers/:id/status')
  @Roles('admin') @ApiBearerAuth()
  @ApiOperation({ summary: 'Verificar/activar, suspender o devolver el perfil a revisión.' })
  updateStatus(@Param('id') id: string, @Body() dto: ProviderStatusDto) { return this.providers.updateProviderStatusByAdmin(id, dto.status); }
}

@ApiTags('Solicitudes de asistencia vial')
@ApiBearerAuth()
@Controller('assistance-requests')
export class AssistanceRequestsController {
  constructor(private readonly providers: ProvidersService) {}

  @Post()
  @Roles('user') @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crear solicitud de asistencia; la referencia textual es obligatoria y no genera cobros.' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateAssistanceRequestDto) {
    return this.providers.createRequest(user.id, dto);
  }

  @Get('mine')
  @Roles('user')
  @ApiOperation({ summary: 'Consultar historial paginado de solicitudes propias y sus transiciones.' })
  mine(@CurrentUser() user: AuthenticatedUser, @Query() query: AssistanceHistoryQueryDto) { return this.providers.listMyRequests(user.id, query); }

  @Get('mine/:id')
  @Roles('user')
  @ApiOperation({ summary: 'Consultar una solicitud propia, incluidas coordenadas y eventos de estado.' })
  detail(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) { return this.providers.getMyRequest(user.id, id); }

  @Post('mine/:id/cancel')
  @Roles('user') @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancelar solicitud propia mientras está creada o enviada.' })
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) { return this.providers.cancelMyRequest(user.id, id); }
}
