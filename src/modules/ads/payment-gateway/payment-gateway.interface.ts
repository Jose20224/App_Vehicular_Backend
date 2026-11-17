export interface PaymentInstructions {
  gateway: string;
  method: string;
  instructions: string[];
  reference: string;
}

export interface PaymentGateway {
  readonly name: string;
  createInstructions(input: { paymentId: string; amountUsd: string; currency: string }): PaymentInstructions;
}

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');
