import { price, format } from './index';
import * as model from './model';

export function entry(sku: string): string {
  const p = price(sku);
  const q = model.price(sku);
  return format(p + q);
}
