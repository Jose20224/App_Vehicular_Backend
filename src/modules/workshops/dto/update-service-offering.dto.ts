import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, Length, Max, Min, ValidateIf } from 'class-validator';

export class UpdateServiceOfferingDto {
  @ApiPropertyOptional()
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @Length(2, 120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 600)
  description?: string | null;

  @ApiPropertyOptional({ minimum: 0.01 })
  @ValidateIf((_object, value) => value !== undefined)
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(9999999999.99)
  price_min?: number;

  @ApiPropertyOptional({ minimum: 0.01 })
  @ValidateIf((_object, value) => value !== undefined)
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(9999999999.99)
  price_max?: number;

  @ApiPropertyOptional({ enum: ['USD'] })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['USD'])
  currency?: 'USD';

  @ApiPropertyOptional()
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Length(1, 80)
  unit?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 600)
  notes?: string | null;

  @ApiPropertyOptional()
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  is_active?: boolean;

  @ApiPropertyOptional({ enum: ['draft', 'published', 'suspended'] })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['draft', 'published', 'suspended'])
  publication_status?: 'draft' | 'published' | 'suspended';
}
