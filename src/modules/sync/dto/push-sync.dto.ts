import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsIn, IsObject,
  IsOptional, IsString, IsUUID, Matches, ValidateNested,
} from 'class-validator';

export class SyncMutationDto {
  @IsString() @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i) mutation_id!: string;
  @IsString() @IsIn([
    'profile', 'vehicle', 'vehicle_document', 'insurance_policy',
    'notification_preference', 'emergency_contact', 'assistance_request',
    'reminder', 'notification_log', 'insurer', 'emergency_number', 'service_type',
    'specialty', 'department', 'municipality', 'vehicle_brand', 'vehicle_model',
    'workshop', 'workshop_specialty', 'workshop_photo', 'service_offering', 'assistance_provider',
    'review', 'review_reply', 'ad_plan', 'ad_slot', 'ad_campaign', 'ad_metric',
    'payment', 'invoice', 'payment_proof', 'audit_log', 'refresh_token', 'device_token',
    'sync_device', 'processed_mutation', 'exchange_rate', 'consent_log',
  ]) entity!: string;
  @IsIn(['upsert', 'delete']) operation!: 'upsert' | 'delete';
  @IsUUID() id!: string;
  @IsOptional() @IsString() @Matches(/^(0|[1-9][0-9]{0,18})$/) base_sync_version?: string | null;
  @IsOptional() @IsObject() data?: Record<string, unknown> | null;
  @IsDateString() client_updated_at!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsUUID('all', { each: true }) depends_on_mutation_ids: string[] = [];
}

export class PushSyncDto {
  @IsUUID() device_id!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50)
  @ValidateNested({ each: true }) @Type(() => SyncMutationDto)
  mutations!: SyncMutationDto[];
}
