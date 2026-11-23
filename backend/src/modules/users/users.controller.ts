import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { UsersService } from './users.service';
import { PatchMeDto } from './dto/patch-me.dto';
import { RegisterDeviceDto } from './dto/register-device.dto';

@ApiTags('Usuarios')
@ApiBearerAuth()
@Controller('me')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'Consultar el perfil de la cuenta autenticada.' })
  getMe(@CurrentUser() user: AuthenticatedUser) {
    return this.users.getMe(user.id);
  }

  @Patch()
  @ApiOperation({ summary: 'Actualizar nombre visible y correo del perfil propio.' })
  patchMe(@CurrentUser() user: AuthenticatedUser, @Body() dto: PatchMeDto) {
    return this.users.patchMe(user.id, dto);
  }

  @Post('devices')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Registrar o rotar el token FCM del dispositivo autenticado.' })
  registerDevice(@CurrentUser() user: AuthenticatedUser, @Body() dto: RegisterDeviceDto) {
    return this.users.registerDevice(user, dto);
  }

  @Get('export')
  @ApiOperation({ summary: 'Exportar los datos personales disponibles en el dominio de identidad.' })
  exportMe(@CurrentUser() user: AuthenticatedUser) {
    return this.users.exportMe(user.id);
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Eliminar la cuenta, anonimizar los datos de identidad y revocar los dispositivos.' })
  deleteMe(@CurrentUser() user: AuthenticatedUser) {
    return this.users.deleteMe(user.id);
  }
}
