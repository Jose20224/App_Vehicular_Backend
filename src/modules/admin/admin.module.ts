import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { CatalogsModule } from '../catalogs/catalogs.module';
import { EmergencyNumbersAdminController } from './emergency-numbers-admin.controller';
import { AdminAuditInterceptor } from './admin-audit.interceptor';
import { B11BackofficeService } from './b11-backoffice.service';
import { B11AdminController, BusinessClaimsController } from './b11.controller';
import { RemindersModule } from '../reminders/reminders.module';
import { AdminOpsController } from './ops.controller';

@Module({
  imports: [CatalogsModule, RemindersModule],
  controllers: [EmergencyNumbersAdminController, B11AdminController, BusinessClaimsController, AdminOpsController],
  providers: [B11BackofficeService, AdminAuditInterceptor, { provide: APP_INTERCEPTOR, useExisting: AdminAuditInterceptor }],
})
export class AdminModule {}
