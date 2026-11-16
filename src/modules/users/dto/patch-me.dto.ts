import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, Length } from 'class-validator';

export class PatchMeDto {
  @ApiPropertyOptional({ example: 'José Miguel' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @Length(1, 120)
  display_name?: string;

  @ApiPropertyOptional({ example: 'jose@example.com' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsEmail({}, { message: 'email debe tener un formato válido.' })
  @Length(3, 254)
  email?: string;
}
