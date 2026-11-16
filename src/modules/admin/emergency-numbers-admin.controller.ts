import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CatalogsService } from '../catalogs/catalogs.service';
import { CreateEmergencyNumberDto } from './dto/create-emergency-number.dto';
import { UpdateEmergencyNumberDto } from './dto/update-emergency-number.dto';

@ApiTags('Administración · Números de emergencia')
@ApiBearerAuth()
@Roles('admin')
@Controller('admin/emergency-numbers')
export class EmergencyNumbersAdminController {
  constructor(private readonly catalogs: CatalogsService) {}

  @Get()
  @ApiOperation({ summary: 'Listar números de emergencia, incluidos los aún no verificados.' })
  list() { return this.catalogs.listEmergencyNumbers(true); }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiCreatedResponse({ description: 'Número creado. Por defecto no se publica hasta verificarlo.' })
  @ApiOperation({ summary: 'Crear un número de emergencia; verified=false por defecto.' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateEmergencyNumberDto) {
    return this.catalogs.createEmergencyNumber(dto, user.id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Editar o verificar un número de emergencia; incrementa la versión del catálogo.' })
  update(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdateEmergencyNumberDto) {
    return this.catalogs.updateEmergencyNumber(id, dto, user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Desactivar un número sin eliminar el historial de cambios.' })
  deactivate(@Param('id') id: string) { return this.catalogs.deactivateEmergencyNumber(id); }
}
