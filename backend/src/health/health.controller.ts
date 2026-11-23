import { Public } from '../common/decorators/public.decorator';
import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { HealthService } from './health.service';

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}
  @Public()
  @Get('/health')
  @ApiOperation({ summary: 'Estado de API, PostgreSQL y Redis' })
  async check(@Res() response: Response) {
    const result = await this.health.check();
    return response.status(result.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).json(result);
  }
}
