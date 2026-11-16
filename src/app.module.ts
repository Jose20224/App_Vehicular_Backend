import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AppConfigModule } from './config/config.module';
import { PrismaModule } from './database/prisma.module';
import { RedisModule } from './redis/redis.module';
import { RedisRateLimitGuard } from './common/guards/redis-rate-limit.guard';
import { HealthModule } from './health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { VehiclesModule } from './modules/vehicles/vehicles.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { RemindersModule } from './modules/reminders/reminders.module';
import { CatalogsModule } from './modules/catalogs/catalogs.module';
import { SyncModule } from './modules/sync/sync.module';
import { WorkshopsModule } from './modules/workshops/workshops.module';
import { ProvidersModule } from './modules/providers/providers.module';
import { ReviewsModule } from './modules/reviews/reviews.module';
import { AdsModule } from './modules/ads/ads.module';
import { BillingModule } from './modules/billing/billing.module';
import { AdminModule } from './modules/admin/admin.module';
import { EmergencyModule } from './modules/emergency/emergency.module';
import { SecurityModule } from './security/security.module';
import { StorageModule } from './storage/storage.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { ResourceOwnerGuard } from './common/guards/resource-owner.guard';

@Module({
  imports: [AppConfigModule, PrismaModule, RedisModule, SecurityModule, StorageModule, HealthModule, AuthModule, UsersModule,
    VehiclesModule, DocumentsModule, RemindersModule, CatalogsModule, EmergencyModule, SyncModule,
    WorkshopsModule, ProvidersModule, ReviewsModule, AdsModule, BillingModule, AdminModule],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: ResourceOwnerGuard },
    { provide: APP_GUARD, useClass: RedisRateLimitGuard },
  ],
})
export class AppModule {}
