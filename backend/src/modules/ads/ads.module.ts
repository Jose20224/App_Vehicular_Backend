import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../../database/prisma.module';
import { ADS_QUEUE } from './ads-queue.constants';
import { AdsController } from './ads.controller';
import { AdsProcessor } from './ads.processor';
import { AdsQueueService } from './ads-queue.service';
import { AdsService } from './ads.service';
import { AdvertiserBillingService } from './advertiser-billing.service';
import { ManualTransferGateway } from './payment-gateway/manual-transfer.gateway';
import { PAYMENT_GATEWAY } from './payment-gateway/payment-gateway.interface';

@Module({
  imports: [PrismaModule, BullModule.registerQueue({ name: ADS_QUEUE })],
  controllers: [AdsController],
  providers: [AdsService, AdvertiserBillingService, ManualTransferGateway, { provide: PAYMENT_GATEWAY, useExisting: ManualTransferGateway }, AdsProcessor, AdsQueueService],
  exports: [AdsService],
})
export class AdsModule {}
