import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({ description: 'JWT refresh token; se rota y no debe reutilizarse.' })
  @IsString()
  @Length(32, 4096)
  refresh_token!: string;
}
