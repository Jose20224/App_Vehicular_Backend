import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsLatitude, IsLongitude, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class SearchAssistanceProvidersQueryDto {
  @ApiPropertyOptional({ example: 12.146 }) @IsOptional() @Transform(({ value }) => value === undefined ? undefined : Number(value)) @IsLatitude() lat?: number;
  @ApiPropertyOptional({ example: -86.273 }) @IsOptional() @Transform(({ value }) => value === undefined ? undefined : Number(value)) @IsLongitude() lng?: number;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() service_type_id?: string;
  @ApiPropertyOptional({ default: 25000, minimum: 100, maximum: 100000 }) @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(100) @Max(100000) radius_meters = 25000;
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 }) @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(1) @Max(50) limit = 20;
}
