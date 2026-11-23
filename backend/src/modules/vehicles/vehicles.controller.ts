import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiConflictResponse, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { ResourceOwner } from '../../common/decorators/resource-owner.decorator';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';
import { VehiclePhotoUploadDto } from './dto/vehicle-photo-upload.dto';
import { ListVehiclesQueryDto } from './dto/list-vehicles-query.dto';
import { VehiclesService } from './vehicles.service';

@ApiTags('Vehículos')
@ApiBearerAuth()
@Controller('vehicles')
export class VehiclesController {
  constructor(private readonly vehicles: VehiclesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Registrar un vehículo usando el UUID v7 generado por el cliente.' })
  @ApiCreatedResponse({ description: 'Vehículo creado; una repetición idéntica devuelve 200.' })
  @ApiOkResponse({ description: 'La misma creación ya había sido aplicada; respuesta idempotente.' })
  @ApiConflictResponse({ description: 'Colisión de UUID, placa duplicada, contenido diferente o límite alcanzado.' })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateVehicleDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.vehicles.create(user.id, dto);
    if (result.idempotent_replay === true) response.status(HttpStatus.OK);
    return result;
  }

  @Get()
  @ApiOperation({ summary: 'Listar los vehículos activos de la cuenta autenticada.' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListVehiclesQueryDto) {
    return this.vehicles.list(user.id, query);
  }

  @Get(':id/summary')
  @ResourceOwner('vehicle')
  @ApiOperation({ summary: 'Consultar el vehículo con cantidad de documentos y próximo vencimiento.' })
  summary(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.vehicles.summary(user.id, id);
  }

  @Get(':id')
  @ResourceOwner('vehicle')
  @ApiOperation({ summary: 'Consultar un vehículo propio.' })
  getOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.vehicles.getOne(user.id, id);
  }

  @Patch(':id')
  @ResourceOwner('vehicle')
  @ApiOperation({ summary: 'Actualizar campos de un vehículo propio.' })
  update(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdateVehicleDto) {
    return this.vehicles.update(user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ResourceOwner('vehicle')
  @ApiOperation({ summary: 'Borrar lógicamente un vehículo y ocultar sus documentos asociados.' })
  delete(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.vehicles.delete(user.id, id);
  }

  @Post(':id/photo/upload-url')
  @HttpCode(HttpStatus.OK)
  @ResourceOwner('vehicle')
  @ApiOperation({ summary: 'Solicitar una URL firmada para subir la fotografía del vehículo.' })
  createPhotoUploadUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: VehiclePhotoUploadDto,
  ) {
    return this.vehicles.createPhotoUploadUrl(user.id, id, dto);
  }

  @Post(':id/photo/confirm')
  @HttpCode(HttpStatus.OK)
  @ResourceOwner('vehicle')
  @ApiOperation({ summary: 'Confirmar la subida y publicar la fotografía del vehículo.' })
  confirmPhotoUpload(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.vehicles.confirmPhotoUpload(user.id, id);
  }
}
