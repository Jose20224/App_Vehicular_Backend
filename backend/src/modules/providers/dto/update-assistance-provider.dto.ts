import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsLatitude, IsLongitude, IsObject, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';

export class UpdateAssistanceProviderDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(2, 140) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(2, 32) provider_type?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() service_type_id?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 1000) description?: string | null;
  @ApiPropertyOptional({ example: '+50588887777' }) @IsOptional() @IsString() @Matches(/^\+[1-9]\d{7,14}$/) phone_e164?: string;
  @ApiPropertyOptional({ example: '+50588887777' }) @IsOptional() @IsString() @Matches(/^\+[1-9]\d{7,14}$/) whatsapp_e164?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(3, 300) address_reference_text?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() department_id?: string | null;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() municipality_id?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsLatitude() latitude?: number;
  @ApiPropertyOptional() @IsOptional() @IsLongitude() longitude?: number;
  @ApiPropertyOptional() @IsOptional() @IsObject() coverage_geojson?: Record<string, unknown>;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() is_24_hours?: boolean;
  @ApiPropertyOptional({ enum: ['available', 'busy', 'unavailable'] }) @IsOptional() @IsIn(['available', 'busy', 'unavailable']) availability_status?: 'available' | 'busy' | 'unavailable';
}
