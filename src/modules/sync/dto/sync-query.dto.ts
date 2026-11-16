import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const SYNC_CHANNELS = [
  'all', 'profile', 'vehicles', 'documents', 'policies',
  'notification_preferences', 'emergency_contacts', 'assistance_requests', 'reminders',
] as const;
export type SyncChannel = typeof SYNC_CHANNELS[number];

export class SyncStatusQueryDto {
  @IsString() @Matches(UUID) device_id!: string;
  @IsOptional() @IsString() @MaxLength(40) client_version?: string;
  @IsOptional() @IsString() @IsIn(['android', 'ios']) platform?: string;
}

export class SyncBootstrapQueryDto {
  @IsString() @Matches(UUID) device_id!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit = 50;
  @IsOptional() @IsString() @MaxLength(8192) @Matches(/^[A-Za-z0-9_-]{24,8192}\.[A-Za-z0-9_-]{43}$/) page_token?: string;
}

export class SyncPullQueryDto {
  @IsString() @Matches(UUID) device_id!: string;
  @IsString() @MaxLength(8192) @Matches(/^[A-Za-z0-9_-]{24,8192}\.[A-Za-z0-9_-]{43}$/) cursor!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit = 50;
  @IsOptional() @IsIn(SYNC_CHANNELS) channel: SyncChannel = 'all';
}
