import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsLatitude, IsLongitude, IsObject, IsOptional, IsString, Length, Matches } from 'class-validator';

export class CreateWorkshopDto {
  @ApiProperty({ format: 'uuid', description: 'UUID v7 generado por el cliente.' })
  @IsString()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  id!: string;

  @ApiProperty({ example: 'Taller El Motor' })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @Length(2, 140)
  name!: string;

  @ApiPropertyOptional({ maxLength: 1200 })
  @IsOptional()
  @IsString()
  @Length(1, 1200)
  description?: string | null;

  @ApiPropertyOptional({ example: '+50588887777', description: 'Formato E.164; se cifra en reposo.' })
  @IsOptional()
  @IsString()
  @Matches(/^\+[1-9]\d{7,14}$/)
  phone?: string | null;

  @ApiPropertyOptional({ example: '+50588887777', description: 'Formato E.164; se cifra en reposo.' })
  @IsOptional()
  @IsString()
  @Matches(/^\+[1-9]\d{7,14}$/)
  whatsapp?: string | null;

  @ApiPropertyOptional({ example: 'contacto@taller.example' })
  @IsOptional()
  @IsEmail()
  @Length(5, 254)
  email?: string | null;

  @ApiPropertyOptional({ example: 'Carretera Norte, km 6' })
  @IsOptional()
  @IsString()
  @Length(1, 300)
  address?: string | null;

  @ApiPropertyOptional({ example: 'De la gasolinera, 100 metros al este' })
  @IsOptional()
  @IsString()
  @Length(1, 300)
  address_reference_text?: string | null;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  department_id?: string | null;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  municipality_id?: string | null;

  @ApiPropertyOptional({ example: 12.146, description: 'Latitud WGS84.' })
  @IsOptional()
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional({ example: -86.273, description: 'Longitud WGS84.' })
  @IsOptional()
  @IsLongitude()
  longitude?: number;

  @ApiPropertyOptional({ description: 'Horario semanal por día: { monday: [{ open: "08:00", close: "17:00" }] }' })
  @IsOptional()
  @IsObject()
  weekly_schedule?: Record<string, unknown>;
}
