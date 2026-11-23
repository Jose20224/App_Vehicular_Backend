import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean, IsIn, IsLatitude, IsLongitude, IsObject, IsOptional, IsString, IsUUID,
  Length, Matches,
} from 'class-validator';

export class CreateAssistanceProviderDto {
  @ApiProperty({ format: 'uuid', description: 'UUID v7 generado por el cliente.' })
  @IsString()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  id!: string;

  @ApiProperty({ example: 'Grúas del Norte' })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(2, 140)
  name!: string;

  @ApiProperty({ example: 'grua' })
  @IsString() @Length(2, 32)
  provider_type!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  service_type_id!: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional() @IsString() @Length(1, 1000)
  description?: string | null;

  @ApiProperty({ example: '+50588887777', description: 'Se guarda cifrado con AES-256-GCM y AAD ligada al registro.' })
  @IsString() @Matches(/^\+[1-9]\d{7,14}$/)
  phone_e164!: string;

  @ApiPropertyOptional({ example: '+50588887777' })
  @IsOptional() @IsString() @Matches(/^\+[1-9]\d{7,14}$/)
  whatsapp_e164?: string | null;

  @ApiProperty({ example: 'Del puente, 200 metros al norte' })
  @IsString() @Length(3, 300)
  address_reference_text!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional() @IsUUID()
  department_id?: string | null;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional() @IsUUID()
  municipality_id?: string | null;

  @ApiProperty({ example: 12.146, description: 'Latitud de la base operativa.' })
  @IsLatitude()
  latitude!: number;

  @ApiProperty({ example: -86.273, description: 'Longitud de la base operativa.' })
  @IsLongitude()
  longitude!: number;

  @ApiProperty({ description: 'GeoJSON Polygon o MultiPolygon, longitud primero, latitud después.' })
  @IsObject()
  coverage_geojson!: Record<string, unknown>;

  @ApiPropertyOptional({ default: false })
  @IsOptional() @IsBoolean()
  is_24_hours?: boolean;

  @ApiPropertyOptional({ enum: ['available', 'busy', 'unavailable'], default: 'available' })
  @IsOptional() @IsIn(['available', 'busy', 'unavailable'])
  availability_status?: 'available' | 'busy' | 'unavailable';
}
