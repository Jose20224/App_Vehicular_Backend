import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
export class ProviderStatusDto {
  @ApiProperty({ enum: ['active', 'suspended', 'pending_verification'] })
  @IsIn(['active', 'suspended', 'pending_verification'])
  status!: 'active' | 'suspended' | 'pending_verification';
}
