import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayUnique, IsArray, IsUUID } from 'class-validator';

export class WorkshopSpecialtiesDto {
  @ApiProperty({ type: [String], maxItems: 30, description: 'Lista completa de especialidades activas a asociar.' })
  @IsArray()
  @ArrayMaxSize(30)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  specialty_ids!: string[];
}
