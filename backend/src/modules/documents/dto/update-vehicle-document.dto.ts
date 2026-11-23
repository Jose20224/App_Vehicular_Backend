import { IsDateString, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
export class UpdateVehicleDocumentDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) title?: string;
  @IsOptional() @IsString() @MaxLength(120) issuer_name?: string | null;
  @IsOptional() @IsDateString() valid_from?: string | null;
  @IsOptional() @IsDateString() valid_until?: string | null;
}
