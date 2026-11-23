import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { MaxCurrentVehicleYear } from './max-current-vehicle-year.validator';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
  ValidateIf,
} from 'class-validator';

export class CreateVehicleDto {
  @ApiProperty({ example: '018bcfe5-6800-7abc-8def-0123456789ab', description: 'UUID v7 generado por el cliente antes de guardar el vehículo localmente.' })
  @IsString()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, {
    message: 'id debe ser un UUID versión 7 generado por el cliente.',
  })
  id!: string;

  @ApiProperty({ example: 'M 123456', description: 'La API normaliza la placa a mayúsculas y elimina espacios.' })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.toUpperCase().replace(/\s+/g, '') : value)
  @IsString()
  @Length(3, 16)
  @Matches(/^[A-Z0-9-]+$/, { message: 'plate solo puede contener letras, números y guiones.' })
  plate!: string;

  @ApiProperty({ example: 'Toyota' })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @Length(1, 80)
  brand!: string;

  @ApiProperty({ example: 'Corolla' })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @Length(1, 100)
  model!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Identificador del catálogo; opcional cuando se captura una marca personalizada.' })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, {
    message: 'brand_id debe ser un UUID válido.',
  })
  brand_id?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Identificador del catálogo; debe pertenecer a brand_id.' })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, {
    message: 'model_id debe ser un UUID válido.',
  })
  model_id?: string;

  @ApiProperty({ example: 2022, minimum: 1950, description: 'Hasta el año actual de America/Managua más uno.' })
  @Type(() => Number)
  @IsInt()
  @Min(1950)
  @MaxCurrentVehicleYear()
  model_year!: number;

  @ApiProperty({ enum: ['motorcycle', 'automobile', 'pickup', 'truck', 'bus', 'other'], example: 'motorcycle' })
  @IsIn(['motorcycle', 'automobile', 'pickup', 'truck', 'bus', 'other'], {
    message: 'vehicle_type no es un tipo de vehículo permitido.',
  })
  vehicle_type!: 'motorcycle' | 'automobile' | 'pickup' | 'truck' | 'bus' | 'other';

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

  @ApiPropertyOptional({ example: '3N1AB7AP8KY123456', description: 'VIN opcional; se almacena cifrado.' })
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
