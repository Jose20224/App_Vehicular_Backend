import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class WorkshopContactEventDto {
  @ApiProperty({ enum: ['call', 'whatsapp', 'route_click'] })
  @IsIn(['call', 'whatsapp', 'route_click'])
  event_type!: 'call' | 'whatsapp' | 'route_click';
}
