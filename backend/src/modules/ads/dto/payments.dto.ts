import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class CreateProofUploadDto {
  @ApiProperty({ enum: ['application/pdf', 'image/jpeg', 'image/png'] })
  @IsIn(['application/pdf', 'image/jpeg', 'image/png']) content_type!: string;
  @ApiProperty({ minimum: 1, maximum: 10485760 }) @IsNumber() @Min(1) @Max(10485760) size_bytes!: number;
}

export class CompletePaymentProofDto {
  @ApiProperty() @IsString() @MaxLength(120) bank_reference!: string;
}

export class RejectPaymentDto {
  @ApiProperty() @IsString() @MaxLength(500) reason!: string;
}

export class PaymentListQueryDto {
  @ApiPropertyOptional({ enum: ['pending', 'proof_received', 'approved', 'rejected', 'cancelled'] })
  @IsOptional() @IsIn(['pending', 'proof_received', 'approved', 'rejected', 'cancelled']) status?: string;
}
