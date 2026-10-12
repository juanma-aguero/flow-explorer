import type { PaymentGateway } from './types';

export class PaymentError extends Error {}

export async function chargePayment(gateway: PaymentGateway, amount: number): Promise<string> {
  if (amount <= 0) {
    throw new PaymentError('Nothing to charge');
  }
  const paymentId = await gateway.charge(amount);
  console.log(`Charged ${amount} (${paymentId})`);
  return paymentId;
}
