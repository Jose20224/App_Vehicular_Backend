import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { RemindersService } from './reminders.service';
import { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';

@ApiTags('Recordatorios y notificaciones')
@ApiBearerAuth()
@Controller()
export class RemindersController {
  constructor(private readonly reminders: RemindersService) {}

  @Get('reminders/schedule')
  @ApiOperation({ summary: 'Consultar recordatorios locales próximos hasta 90 días.' })
  schedule(@CurrentUser() user: AuthenticatedUser) { return this.reminders.schedule(user.id); }

  @Get('me/notification-preferences')
  @ApiOperation({ summary: 'Consultar preferencias de recordatorios y canales.' })
  preferences(@CurrentUser() user: AuthenticatedUser) { return this.reminders.preferences(user.id); }

  @Patch('me/notification-preferences')
  @ApiOperation({ summary: 'Actualizar offsets, hora local y canales de notificación.' })
  updatePreferences(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateNotificationPreferencesDto) { return this.reminders.updatePreferences(user.id, dto); }

  @Get('notifications')
  @ApiOperation({ summary: 'Consultar historial propio de notificaciones.' })
  notifications(@CurrentUser() user: AuthenticatedUser, @Query('limit') limit?: string) {
    const parsed = limit && /^\d+$/.test(limit) ? Number(limit) : 50;
    return this.reminders.listNotifications(user.id, parsed);
  }

  @Patch('notifications/:id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Marcar una notificación propia como leída.' })
  markRead(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) { return this.reminders.markRead(user.id, id); }
}
