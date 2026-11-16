import { Transform } from 'class-transformer';
import { IsNumber, IsString, Length, Max, Min, Matches } from 'class-validator';

export class ShareEmergencyMessageDto {
  @IsString() @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  vehicle_id!: string;

  @Transform(({ value }) => typeof value === 'string' && value.trim() !== '' ? Number(value) : value)
  @IsNumber({ maxDecimalPlaces: 7 }) @Min(-90) @Max(90) latitude!: number;

  @Transform(({ value }) => typeof value === 'string' && value.trim() !== '' ? Number(value) : value)
  @IsNumber({ maxDecimalPlaces: 7 }) @Min(-180) @Max(180) longitude!: number;

  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(3, 500) reference!: string;
}
