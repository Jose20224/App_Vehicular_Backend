import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Matches } from 'class-validator';

export class RequestOtpDto {
  @ApiProperty({ example: '+50588881234', description: 'Número de Nicaragua en formato E.164.' })
  @IsString()
  @Matches(/^\+505\d{8}$/, { message: 'phone debe usar +505 seguido de exactamente 8 dígitos.' })
  phone!: string;

  @ApiProperty({ enum: ['sms', 'whatsapp'], example: 'whatsapp' })
  @IsIn(['sms', 'whatsapp'], { message: 'channel debe ser sms o whatsapp.' })
  channel!: 'sms' | 'whatsapp';
}
