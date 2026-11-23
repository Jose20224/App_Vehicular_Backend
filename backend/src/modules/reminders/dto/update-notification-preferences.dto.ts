import { ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsOptional, Matches } from 'class-validator';

export class UpdateNotificationPreferencesDto {
  @IsOptional() @IsArray() @ArrayUnique() @ArrayMaxSize(5) @IsIn([30, 15, 7, 1, 0], { each: true })
  enabled_offsets?: number[];

  @IsOptional() @Matches(/^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$/)
  preferred_time?: string;

  @IsOptional() @IsBoolean() push_enabled?: boolean;
  @IsOptional() @IsBoolean() local_enabled?: boolean;
  @IsOptional() @IsBoolean() in_app_enabled?: boolean;
}
