import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsIn, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class CreateDocumentUploadUrlDto {
  @ApiProperty({ enum: ['application/pdf', 'image/jpeg', 'image/png', 'image/heic'] })
  @IsIn(['application/pdf', 'image/jpeg', 'image/png', 'image/heic'], { message: 'Formato no permitido. Solo se aceptan PDF, JPG, PNG y HEIC.' })
  content_type!: string;

  @ApiProperty({ minimum: 1, maximum: 10485760, example: 245760 })
  @Type(() => Number) @IsInt() @Min(1, { message: 'size_bytes debe ser al menos 1 byte.' }) @Max(10485760, { message: 'El archivo supera el máximo permitido de 10 MB.' })
  size_bytes!: number;

  @ApiPropertyOptional({ example: 'poliza-2026.pdf' })
  @IsOptional() @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 255)
  file_name?: string;
}
