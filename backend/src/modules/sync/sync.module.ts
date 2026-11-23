import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { SecurityModule } from '../../security/security.module';
import { RemindersModule } from '../reminders/reminders.module';
import { ProvidersModule } from '../providers/providers.module';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

@Module({
  imports: [PrismaModule, SecurityModule, RemindersModule, ProvidersModule],
  controllers: [SyncController],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}
