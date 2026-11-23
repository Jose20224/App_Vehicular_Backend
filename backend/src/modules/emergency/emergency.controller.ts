import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { CreateEmergencyContactDto } from './dto/create-emergency-contact.dto';
import { UpdateEmergencyContactDto } from './dto/update-emergency-contact.dto';
import { ShareEmergencyMessageDto } from './dto/share-emergency-message.dto';
import { EmergencyService } from './emergency.service';

@ApiTags('Emergencias y contactos')
@ApiBearerAuth()
@Controller()
export class EmergencyController {
  constructor(private readonly emergency: EmergencyService) {}

  @Get('me/emergency-contacts')
  @ApiOperation({ summary: 'Listar contactos de emergencia propios; los teléfonos se descifran solo para el titular.' })
  list(@CurrentUser() user: AuthenticatedUser) { return this.emergency.listContacts(user.id); }

  @Post('me/emergency-contacts')
  @HttpCode(HttpStatus.CREATED)
  @ApiCreatedResponse({ description: 'Contacto cifrado y guardado; máximo cinco por cuenta.' })
  @ApiOperation({ summary: 'Agregar un contacto de emergencia con UUID v7 generado por el móvil.' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateEmergencyContactDto) {
    return this.emergency.createContact(user.id, dto);
  }

  @Patch('me/emergency-contacts/:id')
  @ApiOperation({ summary: 'Actualizar un contacto propio.' })
  update(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdateEmergencyContactDto) {
    return this.emergency.updateContact(user.id, id, dto);
  }

  @Delete('me/emergency-contacts/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Borrar lógicamente un contacto y purgar su teléfono cifrado.' })
  delete(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) { return this.emergency.deleteContact(user.id, id); }

  @Post('emergency/share-message')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generar texto y enlace WhatsApp con coordenadas, referencia, vehículo y teléfono de cuenta.' })
  shareMessage(@CurrentUser() user: AuthenticatedUser, @Body() dto: ShareEmergencyMessageDto) {
    return this.emergency.createShareMessage(user, dto);
  }
}
