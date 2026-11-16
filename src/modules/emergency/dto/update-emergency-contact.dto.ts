import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Length, Matches } from 'class-validator';

export class UpdateEmergencyContactDto {
  @IsOptional() @Transform(({ value }) => typeof value === 'string' ? value.trim() : value) @IsString() @Length(1, 120) name?: string;
  @IsOptional() @Transform(({ value }) => typeof value === 'string' ? value.trim() : value) @IsString() @Length(1, 40) relationship_label?: string | null;
  @IsOptional() @Transform(({ value }) => typeof value === 'string' ? value.trim().replace(/[\s()-]/g, '') : value) @IsString() @Matches(/^\+[1-9][0-9]{7,14}$/) phone_e164?: string;
  @IsOptional() @IsBoolean() is_primary?: boolean;
}
