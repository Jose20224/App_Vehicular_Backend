import { Module } from '@nestjs/common';
import { WorkshopsController } from './workshops.controller';
import { ServiceOfferingsController } from './service-offerings.controller';
import { WorkshopsService } from './workshops.service';

@Module({
  controllers: [WorkshopsController, ServiceOfferingsController],
  providers: [WorkshopsService],
  exports: [WorkshopsService],
})
export class WorkshopsModule {}
