import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * shadcn/ui 標準の className helper。
 * clsx で条件 className を畳み込み、tailwind-merge で重複 utility を解決。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
