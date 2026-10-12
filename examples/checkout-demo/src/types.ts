export interface Customer {
  id: string;
  isPremium: boolean;
}

export interface Item {
  sku: string;
  price: number;
  /** Bundles contain other items; plain items have none. */
  children?: Item[];
}

export interface Cart {
  customer: Customer;
  items: Item[];
}

export interface Receipt {
  paymentId: string;
  total: number;
  discount: number;
}

/** Implemented elsewhere at runtime (Stripe, a fake in tests, ...). */
export interface PaymentGateway {
  charge(amount: number): Promise<string>;
}
