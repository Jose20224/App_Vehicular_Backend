import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, IsUrl, Length, Matches, MaxLength } from 'class-validator';

export class CreateEmergencyNumberDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 120) label!: string;

  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 40) category!: string;

  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Matches(/^(\+[1-9][0-9]{7,14}|[0-9]{3,10})$/) phone_number!: string;

  @IsOptional() @IsString() @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i) department_id?: string | null;
  @IsOptional() @IsString() @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i) municipality_id?: string | null;
  @IsOptional() @IsString() @Length(1, 180) source_name?: string | null;
  @IsOptional() @IsUrl({ require_protocol: true }) @MaxLength(500) source_url?: string | null;
  @IsOptional() @IsBoolean() verified?: boolean;
  @IsOptional() @IsString() @MaxLength(500) notes?: string | null;
  @IsOptional() @IsBoolean() is_active?: boolean;
}
