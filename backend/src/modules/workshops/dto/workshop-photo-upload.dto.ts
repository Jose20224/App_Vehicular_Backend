import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Min } from 'class-validator';

export class WorkshopPhotoUploadDto {
  @ApiProperty({ enum: ['image/jpeg', 'image/png', 'image/webp'] })
  @IsIn(['image/jpeg', 'image/png', 'image/webp'])
  content_type!: 'image/jpeg' | 'image/png' | 'image/webp';

  @ApiProperty({ minimum: 1024, maximum: 10485760 })
  @Type(() => Number)
  @IsInt()
  @Min(1024)
  size_bytes!: number;

  @ApiPropertyOptional({ maxLength: 160 })
  @IsOptional()
  @IsString()
  @Length(1, 160)
  alt_text?: string;
}
