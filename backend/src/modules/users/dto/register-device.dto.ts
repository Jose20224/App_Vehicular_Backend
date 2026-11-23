import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';

export class RegisterDeviceDto {
  @ApiProperty({ example: '018bcfe5-6800-7abc-8def-0123456789ab' })
  @IsString()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, {
    message: 'device_id debe ser un UUID versión 7 válido.',
  })
  device_id!: string;

  @ApiProperty({ enum: ['android', 'ios'], example: 'android' })
  @IsIn(['android', 'ios'], { message: 'platform debe ser android o ios.' })
  platform!: 'android' | 'ios';

  @ApiProperty({ example: 'fcm-token-de-ejemplo-con-longitud-suficiente' })
  @IsString()
  @Length(20, 4096)
  fcm_token!: string;

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
}
