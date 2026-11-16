import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsString, Min } from 'class-validator';

export class VehiclePhotoUploadDto {
  @ApiProperty({ enum: ['image/jpeg', 'image/png', 'image/webp'], example: 'image/jpeg' })
  @IsString()
  @IsIn(['image/jpeg', 'image/png', 'image/webp'], {
    message: 'content_type debe ser image/jpeg, image/png o image/webp.',
  })
  content_type!: 'image/jpeg' | 'image/png' | 'image/webp';

  @ApiProperty({ example: 245760, minimum: 1024 })
  @Type(() => Number)
  @IsInt()
  @Min(1024)
  size_bytes!: number;
}
