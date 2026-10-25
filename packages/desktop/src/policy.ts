import { z } from 'zod';

export const readySchema = z.object({
  type: z.literal('ready'),
  url: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === 'http:' &&
        url.hostname === '127.0.0.1' &&
        Number(url.port) > 0 &&
        !url.username &&
        !url.password &&
        url.pathname === '/' &&
        !url.search &&
        !url.hash
      );
    }),
});

export const startSchema = z.object({
  type: z.literal('start'),
  project: z.string().min(1),
  home: z.string().min(1),
  token: z.string().min(32),
  cli: z.string().min(1),
  dashboard: z.string().min(1),
});

export function sameOrigin(value: string, origin: string | undefined): boolean {
  try {
    return Boolean(origin) && new URL(value).origin === origin;
  } catch {
    return false;
  }
}

/** External navigation opens in the user's browser; only explicit HTTPS links are accepted. */
export function externalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}
