import { randomBytes } from 'node:crypto';

/** Random, URL-safe identifier such as `acc_3f9c0a7b12d4e6f8`. */
export function newId(prefix: string, bytes = 8): string {
  return `${prefix}_${randomBytes(bytes).toString('hex')}`;
}
