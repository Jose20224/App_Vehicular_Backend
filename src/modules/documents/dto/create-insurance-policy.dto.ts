import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsDateString, IsIn, IsNumber, IsOptional, IsString, Length, Matches, Min, ValidateIf } from 'class-validator';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class CreateInsurancePolicyDto {
  @ApiProperty({ description: 'UUID v7 de la póliza generado por el cliente.' })
  @IsString() @Matches(UUID_V7) id!: string;
  @ApiProperty({ description: 'UUID v7 del documento asociado generado por el cliente.' })
  @IsString() @Matches(UUID_V7) document_id!: string;
  @ApiPropertyOptional({ format: 'uuid' })
  @ValidateIf((o) => o.other_insurer_name === undefined)
  @IsString() @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  insurer_id?: string;
  @ApiPropertyOptional({ example: 'Aseguradora no listada' })
  @ValidateIf((o) => o.insurer_id === undefined)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 120)
  other_insurer_name?: string;
  @ApiProperty({ example: 'POL-2026-001' })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 120)
  policy_number!: string;
  @ApiProperty({ format: 'date', example: '2026-01-01' }) @IsDateString() @Matches(/^\d{4}-\d{2}-\d{2}$/) valid_from!: string;
  @ApiProperty({ format: 'date', example: '2026-12-31' }) @IsDateString() @Matches(/^\d{4}-\d{2}-\d{2}$/) valid_until!: string;
  @ApiPropertyOptional({ minimum: 0, example: 500 })
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0, { message: 'El deducible no puede ser negativo.' }) deductible?: number;
  @ApiPropertyOptional({ minimum: 0, example: 450 })
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0, { message: 'La prima no puede ser negativa.' }) premium?: number;
  @ApiProperty({ enum: ['USD', 'NIO'], default: 'USD' }) @IsIn(['USD', 'NIO'], { message: 'La moneda debe ser USD o NIO.' }) currency: 'USD' | 'NIO' = 'USD';
  @ApiPropertyOptional({ example: '+50522223333' })
  @IsOptional() @Transform(({ value }) => typeof value === 'string' ? value.trim() : value) @IsString() @Length(8, 20) @Matches(/^\+?[0-9]{8,19}$/) claims_phone?: string;
  @ApiPropertyOptional({ example: 'Póliza de seguro vehicular' })
  @IsOptional() @Transform(({ value }) => typeof value === 'string' ? value.trim() : value) @IsString() @Length(1, 120) title?: string;
}
