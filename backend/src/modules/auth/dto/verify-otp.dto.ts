import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, Length, Matches, ValidateNested } from 'class-validator';

class ConsentAcceptanceDto {
  @ApiProperty({ example: 'privacy-2026-11-v1' })
  @IsString()
  @Length(1, 40)
  policy_version!: string;

  @ApiProperty({ example: true })
  @IsBoolean()
  accepted!: boolean;
}

export class VerifyOtpDto {
  @ApiProperty({ example: '+50588881234' })
  @IsString()
  @Matches(/^\+505\d{8}$/, { message: 'phone debe usar +505 seguido de exactamente 8 dígitos.' })
  phone!: string;

  @ApiProperty({ example: '123456', minLength: 4, maxLength: 10 })
  @IsString()
  @Matches(/^\d{4,10}$/, { message: 'code debe contener entre 4 y 10 dígitos.' })
  code!: string;

  @ApiProperty({ example: '018bcfe5-6800-7abc-8def-0123456789ab', description: 'UUID v7 creado por el dispositivo antes de iniciar sesión.' })
  @IsString()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, {
    message: 'device_id debe ser un UUID versión 7 válido.',
  })
  device_id!: string;

  @ApiProperty({ enum: ['android', 'ios'], example: 'android' })
  @IsIn(['android', 'ios'], { message: 'platform debe ser android o ios.' })
  platform!: 'android' | 'ios';

  @ApiPropertyOptional({ example: 'Pixel 9' })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  device_label?: string;

  @ApiPropertyOptional({ example: '1.0.0' })
  @IsOptional()
  @IsString()
  @Length(1, 40)
  app_version?: string;

  @ApiPropertyOptional({ type: ConsentAcceptanceDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ConsentAcceptanceDto)
  consent?: ConsentAcceptanceDto;

  @ApiPropertyOptional({ example: 'José Miguel' })
  @IsOptional()
  @IsString()
  @Length(1, 120)
  display_name?: string;
}
