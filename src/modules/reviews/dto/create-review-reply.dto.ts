import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Length } from 'class-validator';

export class CreateReviewReplyDto {
  @ApiProperty({ minLength: 1, maxLength: 1200, example: 'Gracias por compartir tu experiencia. Nos alegra haberte atendido.' })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @Length(1, 1200)
  reply_text!: string;
}
