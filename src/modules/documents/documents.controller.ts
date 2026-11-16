import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiCreatedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { ResourceOwner } from '../../common/decorators/resource-owner.decorator';
import { CreateVehicleDocumentDto } from './dto/create-vehicle-document.dto';
import { CreateDocumentUploadUrlDto } from './dto/create-document-upload-url.dto';
import { CreateInsurancePolicyDto } from './dto/create-insurance-policy.dto';
import { UpdateVehicleDocumentDto } from './dto/update-vehicle-document.dto';
import { DocumentsService } from './documents.service';

@ApiTags('Documentos y pólizas')
@ApiBearerAuth()
@Controller()
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get('vehicles/:vehicle_id/documents')
  @ResourceOwner('vehicle', 'vehicle_id')
  @ApiOperation({ summary: 'Listar documentos del vehículo autenticado.' })
  list(@CurrentUser() user: AuthenticatedUser, @Param('vehicle_id') vehicleId: string) {
    return this.documents.list(user.id, vehicleId);
  }

  @Post('vehicles/:vehicle_id/documents')
  @HttpCode(HttpStatus.CREATED)
  @ResourceOwner('vehicle', 'vehicle_id')
  @ApiCreatedResponse({ description: 'Registra el documento en estado pendiente_subida.' })
  @ApiOperation({ summary: 'Registrar un documento antes de subir el archivo.' })
  create(@CurrentUser() user: AuthenticatedUser, @Param('vehicle_id') vehicleId: string, @Body() dto: CreateVehicleDocumentDto, @Res({ passthrough: true }) response: Response) {
    return this.documents.create(user.id, vehicleId, dto).then((result) => {
      if (result.idempotent_replay === true) response.status(HttpStatus.OK);
      return result;
    });
  }

  @Get('documents/:id')
  @ResourceOwner('vehicle_document')
  @ApiOperation({ summary: 'Consultar un documento propio.' })
  getOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.documents.getOne(user.id, id);
  }

  @Patch('documents/:id')
  @ResourceOwner('vehicle_document')
  @ApiOperation({ summary: 'Editar datos y fecha de vencimiento; reemplaza la programación de recordatorios.' })
  update(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdateVehicleDocumentDto) {
    return this.documents.update(user.id, id, dto);
  }

  @Post('documents/:id/upload-url')
  @HttpCode(HttpStatus.OK)
  @ResourceOwner('vehicle_document')
  @ApiOperation({ summary: 'Solicitar URL firmada para subir un PDF o imagen de documento.' })
  uploadUrl(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: CreateDocumentUploadUrlDto) {
    return this.documents.createUploadUrl(user.id, id, dto);
  }

  @Post('documents/:id/confirm')
  @HttpCode(HttpStatus.OK)
  @ResourceOwner('vehicle_document')
  @ApiOperation({ summary: 'Verificar el objeto en S3 y marcarlo disponible solo tras validar contenido real.' })
  confirm(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.documents.confirmUpload(user.id, id);
  }

  @Post('documents/:id/download-url')
  @HttpCode(HttpStatus.OK)
  @ResourceOwner('vehicle_document')
  @ApiOperation({ summary: 'Crear URL firmada de corta duración para descargar un documento disponible.' })
  downloadUrl(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.documents.downloadUrl(user.id, id);
  }

  @Get('vehicles/:vehicle_id/policies')
  @ResourceOwner('vehicle', 'vehicle_id')
  @ApiOperation({ summary: 'Consultar póliza vigente e historial de renovaciones del vehículo.' })
  policies(@CurrentUser() user: AuthenticatedUser, @Param('vehicle_id') vehicleId: string) {
    return this.documents.policies(user.id, vehicleId);
  }

  @Post('vehicles/:vehicle_id/policies')
  @HttpCode(HttpStatus.CREATED)
  @ResourceOwner('vehicle', 'vehicle_id')
  @ApiCreatedResponse({ description: 'Crea una póliza y archiva la vigencia anterior si existe.' })
  @ApiOperation({ summary: 'Registrar o renovar una póliza de seguro.' })
  createPolicy(@CurrentUser() user: AuthenticatedUser, @Param('vehicle_id') vehicleId: string, @Body() dto: CreateInsurancePolicyDto, @Res({ passthrough: true }) response: Response) {
    return this.documents.createPolicy(user.id, vehicleId, dto).then((result) => {
      if (result.idempotent_replay === true) response.status(HttpStatus.OK);
      return result;
    });
  }
}
