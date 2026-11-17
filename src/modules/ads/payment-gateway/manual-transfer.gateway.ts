import { Injectable } from '@nestjs/common';
import type { PaymentGateway, PaymentInstructions } from './payment-gateway.interface';

@Injectable()
export class ManualTransferGateway implements PaymentGateway {
  readonly name = 'manual_transfer';

  createInstructions(input: { paymentId: string; amountUsd: string; currency: string }): PaymentInstructions {
    return {
      gateway: this.name,
      method: 'bank_transfer',
      reference: `ADS-${input.paymentId}`,
      instructions: [
        `Transfiere ${input.amountUsd} ${input.currency} a la cuenta bancaria configurada por administración.`,
        'Incluye la referencia ADS indicada en esta orden y conserva el comprobante.',
        'Adjunta el comprobante para que el equipo administrativo concilie el pago.',
      ],
    };
  }
}
