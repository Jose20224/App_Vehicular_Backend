import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class CreateReviewDto {
  @ApiProperty({ format: 'uuid', description: 'Taller activo que el usuario desea calificar.' })
  @IsString()
  @Matches(UUID_RE)
  workshop_id!: string;

  @ApiProperty({ minimum: 1, maximum: 5, example: 5 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @ApiPropertyOptional({ format: 'uuid', description: 'Vehículo propio opcional; nunca se acepta uno de otra cuenta.' })
  @IsOptional()
  @IsString()
  @Matches(UUID_RE)
  vehicle_id?: string | null;

  @ApiPropertyOptional({ maxLength: 500, example: 'Atención rápida y buen trabajo.' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() || null : value)
  @IsString()
  @MaxLength(500)
  comment?: string | null;
}
