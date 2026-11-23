import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
export class AssistanceHistoryQueryDto {
  @ApiPropertyOptional({ default: 20 }) @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(1) @Max(50) limit = 20;
  @ApiPropertyOptional({ default: 0 }) @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(0) @Max(10000) offset = 0;
}
