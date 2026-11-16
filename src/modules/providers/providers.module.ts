import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AppConfigService } from '../../config/config.module';
import { ASSISTANCE_NOTIFICATION_ADAPTER, MockAssistanceNotificationAdapter, TwilioAssistanceNotificationAdapter } from './assistance-notification.adapter';
import { ASSISTANCE_NOTIFICATION_QUEUE } from './assistance-queue.constants';
import { AssistanceQueueService } from './assistance-queue.service';
import { AssistanceRateLimitService } from './assistance-rate-limit.service';
import { AssistanceProcessor } from './assistance.processor';
import { AssistanceActionsController } from './assistance-actions.controller';
import { AssistanceRequestsController, ProvidersController } from './providers.controller';
import { ProvidersService } from './providers.service';

@Module({
  imports: [BullModule.registerQueue({ name: ASSISTANCE_NOTIFICATION_QUEUE })],
  controllers: [ProvidersController, AssistanceRequestsController, AssistanceActionsController],
  providers: [
    ProvidersService,
    AssistanceQueueService,
    AssistanceRateLimitService,
    AssistanceProcessor,
    MockAssistanceNotificationAdapter,
    TwilioAssistanceNotificationAdapter,
    {
      provide: ASSISTANCE_NOTIFICATION_ADAPTER,
      inject: [AppConfigService, MockAssistanceNotificationAdapter, TwilioAssistanceNotificationAdapter],
      useFactory: (config: AppConfigService, mock: MockAssistanceNotificationAdapter, twilio: TwilioAssistanceNotificationAdapter) =>
        config.value.assistanceNotificationMode === 'twilio' ? twilio : mock,
    },
  ],
  exports: [AssistanceQueueService, AssistanceRateLimitService, ProvidersService],
})
export class ProvidersModule {}
