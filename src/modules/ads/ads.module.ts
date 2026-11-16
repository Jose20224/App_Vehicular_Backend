import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../../database/prisma.module';
import { ADS_QUEUE } from './ads-queue.constants';
import { AdsController } from './ads.controller';
import { AdsProcessor } from './ads.processor';
import { AdsQueueService } from './ads-queue.service';
import { AdsService } from './ads.service';

@Module({
  imports: [PrismaModule, BullModule.registerQueue({ name: ADS_QUEUE })],
  controllers: [AdsController],
  providers: [AdsService, AdsProcessor, AdsQueueService],
  exports: [AdsService],
})
export class AdsModule {}
