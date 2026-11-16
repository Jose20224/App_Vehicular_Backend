import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';

export class ModerateReviewDto {
  @ApiProperty({ enum: ['approve', 'reject', 'remove'] })
  @IsIn(['approve', 'reject', 'remove'])
  decision!: 'approve' | 'reject' | 'remove';

  @ApiPropertyOptional({ maxLength: 300, description: 'Obligatorio para rechazar o retirar una reseña.' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @Length(1, 300)
  reason?: string;
}
