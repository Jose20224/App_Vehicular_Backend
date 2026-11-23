import { Body, Controller, Delete, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CreateServiceOfferingDto } from './dto/create-service-offering.dto';
import { UpdateServiceOfferingDto } from './dto/update-service-offering.dto';
import { WorkshopsService } from './workshops.service';

@ApiTags('Ofertas de servicio')
@ApiBearerAuth()
@Controller('service-offerings')
export class ServiceOfferingsController {
  constructor(private readonly workshops: WorkshopsService) {}

  @Post()
  @Roles('workshop_owner', 'provider_owner')
  @HttpCode(HttpStatus.CREATED)
  @ApiCreatedResponse({ description: 'Crea una oferta en borrador y exige exactamente un dueño.' })
  @ApiOperation({ summary: 'Crear un precio estimado para un taller o proveedor propio.' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateServiceOfferingDto) {
    return this.workshops.createServiceOffering(user.id, dto);
  }

  @Patch(':id')
  @Roles('workshop_owner', 'provider_owner')
  @ApiOperation({ summary: 'Actualizar precio, descripción o estado de publicación de una oferta propia.' })
  update(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdateServiceOfferingDto) {
    return this.workshops.updateServiceOffering(user.id, id, dto);
  }

  @Delete(':id')
  @Roles('workshop_owner', 'provider_owner')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retirar lógicamente una oferta propia.' })
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.workshops.deleteServiceOffering(user.id, id);
  }
}
