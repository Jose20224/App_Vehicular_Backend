import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateBusinessClaimDto {
  @ApiProperty() @IsUUID() business_id!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) evidence?: string;
}
export class ReviewBusinessClaimDto {
  @ApiProperty({ enum: ['approve', 'reject'] }) @IsIn(['approve', 'reject']) decision!: 'approve' | 'reject';
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
export class BulkEmergencyCsvDto {
  @ApiProperty({ description: 'Contenido CSV con columnas label,category,phone_number y opcionales department_id,municipality_id,source_name,source_url,notes.' })
  @IsString() @MaxLength(2_000_000) csv!: string;
}
export class CatalogActiveDto {
  @ApiProperty() @IsString() @MaxLength(50) catalog!: string;
  @ApiProperty() @IsUUID() item_id!: string;
  @ApiProperty() @IsIn(['true', 'false']) is_active!: 'true' | 'false';
}
