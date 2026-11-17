import { Controller, Get, HttpCode, HttpStatus, Post, ServiceUnavailableException } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AppConfigService } from '../../config/config.module';
import { Roles } from '../../common/decorators/roles.decorator';
import { ReminderQueueService } from '../reminders/reminder-queue.service';

@ApiTags('Operaciones')
@ApiBearerAuth()
@Roles('admin')
@Controller('admin/ops/reminders')
export class AdminOpsController {
  constructor(private readonly config: AppConfigService, private readonly queue: ReminderQueueService) {}

  @Get('queue') queueStatus() { return this.queue.queueSnapshot(); }

  @Post('dispatch-due') @HttpCode(HttpStatus.ACCEPTED)
  async dispatchDueForLoadTest() {
    if (this.config.value.nodeEnv !== 'test') throw new ServiceUnavailableException({
      code: 'TEST_OPERATION_DISABLED', message: 'La operación de prueba solo está disponible en NODE_ENV=test.', details: {},
    });
    return { enqueued: await this.queue.dispatchDue(1), queue: await this.queue.queueSnapshot() };
  }
}
