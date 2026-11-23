import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { SyncService } from './sync.service';
import { SyncBootstrapQueryDto, SyncPullQueryDto, SyncStatusQueryDto } from './dto/sync-query.dto';
import { PushSyncDto } from './dto/push-sync.dto';

@ApiTags('Sincronización offline')
@ApiBearerAuth()
@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Get('status')
  @ApiOperation({ summary: 'Negocia versión de protocolo, dispositivo y canales sincronizables.' })
  status(@CurrentUser() user: AuthenticatedUser, @Query() query: SyncStatusQueryDto) {
    return this.sync.status(user, query);
  }

  @Get('bootstrap')
  @ApiOperation({ summary: 'Descarga por páginas una instantánea inicial del usuario.' })
  bootstrap(@CurrentUser() user: AuthenticatedUser, @Query() query: SyncBootstrapQueryDto) {
    return this.sync.bootstrap(user, query);
  }

  @Get('pull')
  @ApiOperation({ summary: 'Obtiene cambios y tombstones por canal desde un cursor opaco.' })
  pull(@CurrentUser() user: AuthenticatedUser, @Query() query: SyncPullQueryDto) {
    return this.sync.pull(user, query);
  }

  @Post('push')
  @ApiOperation({ summary: 'Aplica un lote independiente e idempotente de mutaciones offline.' })
  push(@CurrentUser() user: AuthenticatedUser, @Body() body: PushSyncDto) {
    return this.sync.push(user, body);
  }
}
