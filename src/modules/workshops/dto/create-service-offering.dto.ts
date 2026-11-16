import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsNumber, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';

export class CreateServiceOfferingDto {
  @ApiProperty({ format: 'uuid', description: 'UUID v7 generado por el cliente.' })
  @IsString()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  id!: string;

  @ApiProperty({ enum: ['workshop', 'assistance_provider'] })
  @IsIn(['workshop', 'assistance_provider'])
  owner_type!: 'workshop' | 'assistance_provider';

  @ApiProperty({ format: 'uuid' })
  @IsString()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  owner_id!: string;

  @ApiProperty({ format: 'uuid' })
  @IsString()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  service_type_id!: string;

  @ApiProperty({ example: 'Cambio de aceite' })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @Length(2, 120)
  name!: string;

  @ApiPropertyOptional({ maxLength: 600 })
  @IsOptional()
  @IsString()
  @Length(1, 600)
  description?: string | null;

  @ApiProperty({ example: 15.5, minimum: 0.01 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(9999999999.99)
  price_min!: number;

  @ApiProperty({ example: 25, minimum: 0.01 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(9999999999.99)
  price_max!: number;

  @ApiPropertyOptional({ enum: ['USD'], default: 'USD' })
  @IsOptional()
  @IsIn(['USD'])
  currency: 'USD' = 'USD';

  @ApiProperty({ example: 'por servicio' })
  @IsString()
  @Length(1, 80)
  unit!: string;

  @ApiPropertyOptional({ maxLength: 600 })
  @IsOptional()
  @IsString()
  @Length(1, 600)
  notes?: string | null;
}
