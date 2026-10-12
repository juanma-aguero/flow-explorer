import type { Customer, Item } from './types';
import { roundMoney } from './legacy-money.js';

/** Sums an item and, recursively, everything bundled inside it. */
export function itemTotal(item: Item): number {
  let total = item.price;
  for (const child of item.children ?? []) {
    total += itemTotal(child);
  }
  return total;
}

export function calculateTotal(items: Item[]): number {
  let total = 0;
  for (const item of items) {
    total += itemTotal(item);
  }
  return roundMoney(total);
}

export async function applyDiscount(total: number, customer: Customer): Promise<number> {
  if (customer.isPremium) {
    return applyPremiumDiscount(total);
  } else if (total > 100) {
    return applyBulkDiscount(total);
  }
  return 0;
}

function applyPremiumDiscount(total: number): number {
  return roundMoney(total * 0.2);
}

function applyBulkDiscount(total: number): number {
  return roundMoney(total * 0.05);
}
