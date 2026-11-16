import { Controller, Get, Header, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { ProvidersService } from './providers.service';

@ApiTags('Acciones de proveedor (enlace de un solo uso)')
@Controller('assistance-actions')
export class AssistanceActionsController {
  constructor(private readonly providers: ProvidersService) {}

  @Public()
  @Get(':token')
  @Header('Cache-Control', 'no-store, private')
  @ApiOperation({ summary: 'Mostrar la acción pendiente sin consumir el token; requiere confirmación explícita.' })
  async preview(@Param('token') token: string, @Res() response: Response): Promise<void> {
    const html = await this.providers.getActionPageHtml(token);
    response.status(200).type('html').send(html);
  }

  @Public()
  @Post(':token/confirm')
  @Header('Cache-Control', 'no-store, private')
  @ApiOperation({ summary: 'Consumir una única vez el token y aplicar el siguiente estado permitido.' })
  async confirm(@Param('token') token: string, @Res() response: Response): Promise<void> {
    const html = await this.providers.getActionResultHtml(token);
    response.status(200).type('html').send(html);
  }
}
