import { randomToken, sha256 } from './crypto';

/** The subset of Cloudflare D1 this worker uses (also implemented over SQLite in tests). */
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
}
export interface D1Like {
  prepare(sql: string): D1Statement;
}

export interface User {
  id: string;
  email: string;
  email_verified: number;
  name: string | null;
  password_hash: string | null;
}

const MINUTE = 60_000;
export const OAUTH_STATE_TTL = 10 * MINUTE;
export const AUTH_CODE_TTL = 5 * MINUTE;
export const VERIFY_TTL = 24 * 60 * MINUTE;
export const REFRESH_TTL = 60 * 24 * 60 * MINUTE;

export class Store {
  constructor(
    private readonly db: D1Like,
    private readonly now: () => number = Date.now,
  ) {}

  userByEmail(email: string): Promise<User | null> {
    return this.db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<User>();
  }

  userById(id: string): Promise<User | null> {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<User>();
  }

  async createUser(input: {
    email: string;
    verified: boolean;
    name?: string;
    passwordHash?: string;
  }): Promise<User> {
    const user: User = {
      id: crypto.randomUUID(),
      email: input.email,
      email_verified: input.verified ? 1 : 0,
      name: input.name ?? null,
      password_hash: input.passwordHash ?? null,
    };
    await this.db
      .prepare(
        'INSERT INTO users (id, email, email_verified, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(user.id, user.email, user.email_verified, user.name, user.password_hash, this.now())
      .run();
    return user;
  }

  async setPassword(userId: string, passwordHash: string): Promise<void> {
    await this.db
      .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .bind(passwordHash, userId)
      .run();
  }

  async markVerified(userId: string, name?: string): Promise<void> {
    await this.db
      .prepare('UPDATE users SET email_verified = 1, name = COALESCE(name, ?) WHERE id = ?')
      .bind(name ?? null, userId)
      .run();
  }

  async identity(provider: string, subject: string): Promise<User | null> {
    return this.db
      .prepare(
        'SELECT users.* FROM identities JOIN users ON users.id = identities.user_id WHERE provider = ? AND subject = ?',
      )
      .bind(provider, subject)
      .first<User>();
  }

  async link(provider: string, subject: string, userId: string): Promise<void> {
    await this.db
      .prepare('INSERT OR IGNORE INTO identities (provider, subject, user_id) VALUES (?, ?, ?)')
      .bind(provider, subject, userId)
      .run();
  }

  /** Remember an OAuth sign-in; returns the state to send to the provider. */
  async saveState(provider: string, redirectTo: string, challenge: string): Promise<string> {
    const state = randomToken();
    await this.db
      .prepare(
        'INSERT INTO oauth_states (state_hash, provider, redirect_to, challenge, expires_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(await sha256(state), provider, redirectTo, challenge, this.now() + OAUTH_STATE_TTL)
      .run();
    return state;
  }

  /** Consume a state once. */
  async takeState(
    state: string,
  ): Promise<{ provider: string; redirect_to: string; challenge: string } | null> {
    const hash = await sha256(state);
    const row = await this.db
      .prepare('SELECT * FROM oauth_states WHERE state_hash = ?')
      .bind(hash)
      .first<{ provider: string; redirect_to: string; challenge: string; expires_at: number }>();
    await this.db.prepare('DELETE FROM oauth_states WHERE state_hash = ?').bind(hash).run();
    return row && row.expires_at > this.now() ? row : null;
  }

  async issueCode(userId: string, challenge: string, provider: string): Promise<string> {
    const code = randomToken();
    await this.db
      .prepare(
        'INSERT INTO auth_codes (code_hash, user_id, challenge, provider, expires_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(await sha256(code), userId, challenge, provider, this.now() + AUTH_CODE_TTL)
      .run();
    return code;
  }

  async takeCode(
    code: string,
  ): Promise<{ user_id: string; challenge: string; provider: string } | null> {
    const hash = await sha256(code);
    const row = await this.db
      .prepare('SELECT * FROM auth_codes WHERE code_hash = ?')
      .bind(hash)
      .first<{ user_id: string; challenge: string; provider: string; expires_at: number }>();
    await this.db.prepare('DELETE FROM auth_codes WHERE code_hash = ?').bind(hash).run();
    return row && row.expires_at > this.now() ? row : null;
  }

  async saveVerification(userId: string, redirectTo: string, challenge: string): Promise<string> {
    const token = randomToken();
    await this.db
      .prepare(
        'INSERT INTO email_verifications (token_hash, user_id, redirect_to, challenge, expires_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(await sha256(token), userId, redirectTo, challenge, this.now() + VERIFY_TTL)
      .run();
    return token;
  }

  async takeVerification(
    token: string,
  ): Promise<{ user_id: string; redirect_to: string; challenge: string } | null> {
    const hash = await sha256(token);
    const row = await this.db
      .prepare('SELECT * FROM email_verifications WHERE token_hash = ?')
      .bind(hash)
      .first<{ user_id: string; redirect_to: string; challenge: string; expires_at: number }>();
    await this.db.prepare('DELETE FROM email_verifications WHERE token_hash = ?').bind(hash).run();
    return row && row.expires_at > this.now() ? row : null;
  }

  async issueRefresh(userId: string, provider: string, sessionId: string): Promise<string> {
    const token = randomToken();
    await this.db
      .prepare(
        'INSERT INTO refresh_tokens (token_hash, session_id, user_id, provider, expires_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(await sha256(token), sessionId, userId, provider, this.now() + REFRESH_TTL)
      .run();
    return token;
  }

  /**
   * Rotate a refresh token: the old one is revoked. Presenting an already revoked token revokes
   * its whole session, since it means the token was copied.
   */
  async rotateRefresh(
    token: string,
  ): Promise<{ user_id: string; provider: string; session_id: string } | null> {
    const hash = await sha256(token);
    const row = await this.db
      .prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?')
      .bind(hash)
      .first<{
        user_id: string;
        provider: string;
        session_id: string;
        expires_at: number;
        revoked: number;
      }>();
    if (!row) return null;
    if (row.revoked) {
      await this.revokeSession(row.session_id);
      return null;
    }
    await this.db
      .prepare('UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?')
      .bind(hash)
      .run();
    return row.expires_at > this.now() ? row : null;
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.db
      .prepare('UPDATE refresh_tokens SET revoked = 1 WHERE session_id = ?')
      .bind(sessionId)
      .run();
  }
}
