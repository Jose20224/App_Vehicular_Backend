import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CreateWorkshopDto } from './dto/create-workshop.dto';
import { UpdateWorkshopDto } from './dto/update-workshop.dto';
import { SearchWorkshopsQueryDto } from './dto/search-workshops-query.dto';
import { WorkshopContactEventDto } from './dto/workshop-contact-event.dto';
import { WorkshopSpecialtiesDto } from './dto/workshop-specialties.dto';
import { WorkshopPhotoUploadDto } from './dto/workshop-photo-upload.dto';
import { UpdateWorkshopStatusDto } from './dto/update-workshop-status.dto';
import { WorkshopsService } from './workshops.service';

@ApiTags('Directorio de talleres')
@Controller('workshops')
export class WorkshopsController {
  constructor(private readonly workshops: WorkshopsService) {}

  @Get('mine')
  @Roles('workshop_owner')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Listar las fichas propias, incluidos borradores y pendientes de verificación.' })
  mine(@CurrentUser() user: AuthenticatedUser) {
    return this.workshops.getOwnedWorkshops(user.id);
  }

  @Get('mine/:id')
  @Roles('workshop_owner')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Consultar una ficha propia completa para editarla antes o después de activarla.' })
  mineDetail(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.workshops.getOwnedWorkshop(user.id, id);
  }

  @Public()
  @Get('search')
  @ApiOperation({ summary: 'Buscar talleres activos por cercanía, especialidad, municipio, texto y horario.' })
  search(@Query() query: SearchWorkshopsQueryDto) {
    return this.workshops.search(query);
  }

  @Public()
  @Get(':slug/contact-details')
  @ApiOperation({ summary: 'Obtener datos públicos de contacto descifrados únicamente para talleres activos.' })
  contactDetails(@Param('slug') slug: string) {
    return this.workshops.getPublicContactDetails(slug);
  }

  @Public()
  @Get(':slug')
  @ApiOperation({ summary: 'Consultar el perfil público de un taller activo.' })
  detail(@Param('slug') slug: string) {
    return this.workshops.getPublicDetail(slug);
  }

  @Public()
  @Post(':slug/contact-events')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Registrar interacción call, whatsapp o route_click sin guardar datos del visitante.' })
  contactEvent(@Param('slug') slug: string, @Body() dto: WorkshopContactEventDto) {
    return this.workshops.createContactEvent(slug, dto.event_type);
  }

  @Post()
  @Roles('workshop_owner')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth()
  @ApiCreatedResponse({ description: 'Crea un perfil de taller en estado draft.' })
  @ApiOperation({ summary: 'Crear la ficha propia de un taller.' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateWorkshopDto) {
    return this.workshops.createWorkshop(user.id, dto);
  }

  @Patch(':id')
  @Roles('workshop_owner')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Actualizar el perfil y los datos de contacto de un taller propio.' })
  update(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdateWorkshopDto) {
    return this.workshops.updateWorkshop(user.id, id, dto);
  }

  @Post(':id/submit-verification')
  @Roles('workshop_owner')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Enviar un perfil completo a verificación administrativa.' })
  submitForVerification(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.workshops.submitForVerification(user.id, id);
  }

  @Patch(':id/status')
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Activar, suspender o devolver a verificación un taller (solo administración).' })
  updateStatus(@Param('id') id: string, @Body() dto: UpdateWorkshopStatusDto) {
    return this.workshops.updateStatusByAdmin(id, dto.status);
  }

  @Put(':id/specialties')
  @Roles('workshop_owner')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Reemplazar la lista de especialidades activas de un taller propio.' })
  replaceSpecialties(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: WorkshopSpecialtiesDto) {
    return this.workshops.replaceSpecialties(user.id, id, dto.specialty_ids);
  }

  @Post(':id/photos/upload-url')
  @Roles('workshop_owner')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Crear metadatos de fotografía y obtener URL S3 firmada.' })
  photoUploadUrl(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: WorkshopPhotoUploadDto) {
    return this.workshops.createPhotoUpload(user.id, id, dto);
  }

  @Post('photos/:photoId/confirm')
  @Roles('workshop_owner')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Verificar el objeto S3 antes de publicar la fotografía del taller.' })
  confirmPhoto(@CurrentUser() user: AuthenticatedUser, @Param('photoId') photoId: string) {
    return this.workshops.confirmPhotoUpload(user.id, photoId);
  }
}
