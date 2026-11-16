import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AppConfigService } from '../../config/config.module';
import { PrismaModule } from '../../database/prisma.module';
import { SecurityModule } from '../../security/security.module';
import { REMINDER_QUEUE } from './reminder-queue.constants';
import { RemindersController } from './reminders.controller';
import { RemindersService } from './reminders.service';
import { ReminderQueueService } from './reminder-queue.service';
import { ReminderProcessor } from './reminder.processor';
import { FcmService } from './fcm.service';

@Module({
  imports: [PrismaModule, SecurityModule, BullModule.forRootAsync({
    inject: [AppConfigService],
    useFactory: (config: AppConfigService) => {
      const url = new URL(config.value.redisUrl);
      const tls = url.protocol === 'rediss:' ? {} : undefined;
      return { connection: {
        host: url.hostname, port: Number(url.port || 6379),
        ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
        ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
        ...(url.pathname.length > 1 ? { db: Number(url.pathname.slice(1)) } : {}),
        ...(tls ? { tls } : {}), maxRetriesPerRequest: null,
      } };
    },
  }), BullModule.registerQueue({ name: REMINDER_QUEUE })],
  controllers: [RemindersController],
  providers: [RemindersService, ReminderQueueService, ReminderProcessor, FcmService],
  exports: [RemindersService],
})
export class RemindersModule {}
