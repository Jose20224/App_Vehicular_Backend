import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Length, Matches } from 'class-validator';

export class CreateEmergencyContactDto {
  @IsString() @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  id!: string;

  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 120) name!: string;

  @IsOptional() @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 40) relationship_label?: string;

  @Transform(({ value }) => typeof value === 'string' ? value.trim().replace(/[\s()-]/g, '') : value)
  @IsString() @Matches(/^\+[1-9][0-9]{7,14}$/) phone_e164!: string;

  @IsOptional() @IsBoolean() is_primary?: boolean;
}
