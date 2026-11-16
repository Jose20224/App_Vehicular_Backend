import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import type { AdBillingPeriod, AdMetricEventType } from '../../../generated/prisma/client';

export class CreateAdCampaignDto {
  @ApiProperty() @IsString() @MaxLength(120) campaign_name!: string;
  @ApiProperty() @IsString() @MaxLength(40) plan_code!: string;
  @ApiProperty() @IsString() @MaxLength(40) slot_code!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() workshop_id?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() assistance_provider_id?: string;
  @ApiProperty({ enum: ['monthly', 'quarterly', 'annual'] }) @IsIn(['monthly', 'quarterly', 'annual']) billing_period!: AdBillingPeriod;
  @ApiPropertyOptional({ description: 'Fecha UTC de inicio; por defecto comienza al enviar a pago.' }) @IsOptional() @IsDateString() starts_at?: string;
}

export class ServeAdsQueryDto {
  @ApiProperty() @IsString() @MaxLength(40) slot_code!: string;
  @ApiProperty() @IsUUID() department_id!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() municipality_id?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 20, default: 3 }) @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(1) @Max(20) limit = 3;
}

export class RecordAdMetricDto {
  @ApiProperty() @IsUUID() campaign_id!: string;
  @ApiProperty({ enum: ['impression', 'click', 'call', 'whatsapp', 'route'] }) @IsIn(['impression', 'click', 'call', 'whatsapp', 'route']) event_type!: AdMetricEventType;
}

export class UpsertAdPlanDto {
  @ApiProperty() @IsString() @MaxLength(40) code!: string;
  @ApiProperty() @IsString() @MaxLength(100) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) description?: string;
  @ApiProperty() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) price_usd!: number;
  @ApiPropertyOptional({ default: 30 }) @IsOptional() @IsInt() @Min(1) duration_days?: number;
  @ApiPropertyOptional({ default: 0 }) @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) quarterly_discount_percent?: number;
  @ApiPropertyOptional({ default: 0 }) @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) annual_discount_percent?: number;
  @ApiPropertyOptional({ default: 36.7, description: 'Tipo de cambio referencial NIO/USD; no cambia el precio cobrado en USD.' }) @IsOptional() @IsNumber({ maxDecimalPlaces: 8 }) @Min(0.00000001) nio_per_usd?: number;
  @ApiPropertyOptional() @IsOptional() @IsObject() features?: Record<string, unknown>;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() is_active?: boolean;
}

export class UpsertAdSlotDto {
  @ApiProperty() @IsString() @MaxLength(40) code!: string;
  @ApiProperty() @IsString() @MaxLength(100) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) description?: string;
  @ApiPropertyOptional({ default: 20 }) @IsOptional() @IsInt() @Min(1) max_active_campaigns?: number;
  @ApiPropertyOptional({ default: 3 }) @IsOptional() @IsInt() @Min(1) max_active_per_department?: number;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() is_active?: boolean;
}
