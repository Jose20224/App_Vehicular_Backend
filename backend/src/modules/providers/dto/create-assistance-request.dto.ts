import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsLatitude, IsLongitude, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';

export class CreateAssistanceRequestDto {
  @ApiProperty({ format: 'uuid', description: 'UUID v7 para permitir creación local y posterior sync.' })
  @IsString() @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  id!: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() vehicle_id?: string | null;
  @ApiProperty({ format: 'uuid' }) @IsUUID() service_type_id!: string;
  @ApiProperty({ maxLength: 1000 }) @IsString() @Length(1, 1000) issue_description!: string;
  @ApiProperty({ maxLength: 300, description: 'Obligatoria incluso cuando hay coordenadas GPS.' }) @IsString() @Length(3, 300) address_reference_text!: string;
  @ApiPropertyOptional({ example: 12.146 }) @IsOptional() @IsLatitude() latitude?: number;
  @ApiPropertyOptional({ example: -86.273 }) @IsOptional() @IsLongitude() longitude?: number;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() department_id?: string | null;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() municipality_id?: string | null;
  @ApiPropertyOptional({ example: '+50588887777' }) @IsOptional() @IsString() @Matches(/^\+[1-9]\d{7,14}$/) contact_phone?: string | null;
  @ApiPropertyOptional({ enum: ['whatsapp', 'call', 'in_app'], default: 'whatsapp' }) @IsOptional() @IsIn(['whatsapp', 'call', 'in_app']) preferred_contact?: 'whatsapp' | 'call' | 'in_app';
}
