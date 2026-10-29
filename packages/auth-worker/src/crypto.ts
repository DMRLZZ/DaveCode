/** WebCrypto helpers. Everything here runs unchanged on Workers and on Node 22+. */

const encoder = new TextEncoder();

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** A random URL-safe token with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(text: string): Promise<string> {
  return base64url(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

/** Constant-time comparison of two strings. */
export function safeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Workers cap PBKDF2 at 100 000 iterations. */
const PBKDF2_ITERATIONS = 100_000;

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256,
  );
  return base64url(bits);
}

/** `pbkdf2-sha256$<iterations>$<salt>$<hash>` */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${base64url(salt)}$${hash}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterations, salt, hash] = stored.split('$');
  if (scheme !== 'pbkdf2-sha256' || !iterations || !salt || !hash) return false;
  return safeEqual(await pbkdf2(password, fromBase64url(salt), Number(iterations)), hash);
}

export interface AccessClaims {
  sub: string;
  email?: string;
  /** The refresh token family this access token belongs to (revoked on logout). */
  sid: string;
  iat: number;
  exp: number;
  iss: string;
}

async function hmacKey(secret: string): ReturnType<typeof crypto.subtle.importKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signJwt(claims: AccessClaims, secret: string): Promise<string> {
  const header = base64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = base64url(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret),
    encoder.encode(`${header}.${body}`),
  );
  return `${header}.${body}.${base64url(signature)}`;
}

/** The claims of a valid, unexpired token signed with `secret`, or undefined. */
export async function verifyJwt(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<AccessClaims | undefined> {
  const [header, body, signature] = token.split('.');
  if (!header || !body || !signature) return undefined;
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      fromBase64url(signature),
      encoder.encode(`${header}.${body}`),
    );
  } catch {
    return undefined;
  }
  if (!valid) return undefined;
  try {
    const head = JSON.parse(new TextDecoder().decode(fromBase64url(header))) as { alg?: string };
    if (head.alg !== 'HS256') return undefined;
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(body))) as AccessClaims;
    return typeof claims.exp === 'number' && claims.exp * 1000 > now ? claims : undefined;
  } catch {
    return undefined;
  }
}
