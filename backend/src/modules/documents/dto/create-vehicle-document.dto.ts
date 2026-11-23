import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Length, Matches, IsDateString } from 'class-validator';

export class CreateVehicleDocumentDto {
  @ApiProperty({ example: '018bcfe5-6800-7abc-8def-0123456789ab', description: 'UUID v7 generado localmente.' })
  @IsString()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  id!: string;

  @ApiProperty({ enum: ['poliza', 'circulacion', 'revision', 'licencia', 'otro'] })
  @IsIn(['poliza', 'circulacion', 'revision', 'licencia', 'otro'], { message: 'El tipo de documento no es válido.' })
  document_type!: 'poliza' | 'circulacion' | 'revision' | 'licencia' | 'otro';

  @ApiProperty({ example: 'Circulación 2026' })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @Length(1, 120)
  title!: string;

  @ApiPropertyOptional({ example: 'Policía Nacional' })
  @IsOptional() @Transform(({ value }) => typeof value === 'string' ? value.trim() : value) @IsString() @Length(1, 120)
  issuer_name?: string;

  @ApiPropertyOptional({ example: '2026-01-01', format: 'date' })
  @IsOptional() @IsDateString() @Matches(/^\d{4}-\d{2}-\d{2}$/) valid_from?: string;

  @ApiPropertyOptional({ example: '2026-12-31', format: 'date' })
  @IsOptional() @IsDateString() @Matches(/^\d{4}-\d{2}-\d{2}$/) valid_until?: string;
}
