import { ApiPropertyOptional } from '@nestjs/swagger';
import { MaxCurrentVehicleYear } from './max-current-vehicle-year.validator';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Matches, Min, ValidateIf } from 'class-validator';

export class UpdateVehicleDto {
  @ApiPropertyOptional({ example: 'M123456' })
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.toUpperCase().replace(/\s+/g, '') : value)
  @IsString()
  @Length(3, 16)
  @Matches(/^[A-Z0-9-]+$/, { message: 'plate solo puede contener letras, números y guiones.' })
  plate?: string;

  @ApiPropertyOptional({ example: 'Toyota' })
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @Length(1, 80)
  brand?: string;

  @ApiPropertyOptional({ example: 'Corolla' })
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @Length(1, 100)
  model?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  brand_id?: string | null;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  model_id?: string | null;

  @ApiPropertyOptional({ minimum: 1950, description: 'Hasta el año actual de America/Managua más uno.' })
  @ValidateIf((_object, value) => value !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(1950)
  @MaxCurrentVehicleYear()
  model_year?: number;

  @ApiPropertyOptional({ enum: ['motorcycle', 'automobile', 'pickup', 'truck', 'bus', 'other'] })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['motorcycle', 'automobile', 'pickup', 'truck', 'bus', 'other'])
  vehicle_type?: 'motorcycle' | 'automobile' | 'pickup' | 'truck' | 'bus' | 'other';

  @ApiPropertyOptional({ example: 'Mi moto' })
  @IsOptional()
  @IsString()
  @Length(1, 80)
  nickname?: string | null;

  @ApiPropertyOptional({ example: 'Negro' })
  @IsOptional()
  @IsString()
  @Length(1, 40)
  color?: string | null;

  @ApiPropertyOptional({ example: '3N1AB7AP8KY123456' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toUpperCase().replace(/\s+/g, '') : value)
  @IsString()
  @Length(5, 32)
  @Matches(/^[A-HJ-NPR-Z0-9]+$/, { message: 'vin solo puede contener letras y números válidos.' })
  vin?: string | null;

  @ApiPropertyOptional({ example: 45200, minimum: 0 })
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  mileage_km?: number | null;
}
