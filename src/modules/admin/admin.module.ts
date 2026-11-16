import { Module } from '@nestjs/common';
import { CatalogsModule } from '../catalogs/catalogs.module';
import { EmergencyNumbersAdminController } from './emergency-numbers-admin.controller';

@Module({ imports: [CatalogsModule], controllers: [EmergencyNumbersAdminController] })
export class AdminModule {}
