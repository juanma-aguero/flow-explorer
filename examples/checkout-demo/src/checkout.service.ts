import type { Cart, PaymentGateway, Receipt } from './types';
import { applyDiscount, calculateTotal } from './pricing';
import { chargePayment } from './payment';

export class CheckoutError extends Error {}

export async function processCheckout(cart: Cart, gateway: PaymentGateway): Promise<Receipt> {
  validateCart(cart);
  const total = calculateTotal(cart.items);
  const discount = await applyDiscount(total, cart.customer);
  try {
    const paymentId = await chargePayment(gateway, total - discount);
    return { paymentId, total, discount };
  } catch (error) {
    console.error('Payment failed', error);
    throw new CheckoutError('Checkout failed');
  }
}

function validateCart(cart: Cart): void {
  if (cart.items.length === 0) {
    throw new CheckoutError('Cart is empty');
  }
}
