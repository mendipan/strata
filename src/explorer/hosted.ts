import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { problem } from './contract.js';

export type HostedOptions = {
  publicOrigin: string;
  trustedProxyAddresses: string[];
  accessKeySha256?: string;
  sessionMs?: number;
  idleMs?: number;
};
const cookieName = '__Host-strata_studio';
const token = () => Buffer.from(randomBytes(32)).toString('base64url');
const equal = (a: string, b: string) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
type Session = { csrf: string; expires: number; idle: number };

export interface HostedReadAccess {
  readonly origin: string;
  boundary(req: IncomingMessage): void;
  require(req: IncomingMessage): void | Promise<void>;
  status(req: IncomingMessage): { mode: string; configured: boolean; authenticated: boolean; csrf: string | null } | Promise<{ mode: string; configured: boolean; authenticated: boolean; csrf: string | null }>;
  login(req: IncomingMessage, res: ServerResponse, input: unknown): unknown;
  logout(req: IncomingMessage, res: ServerResponse): unknown;
  clear(): void;
}

// Explicit reverse-proxy mode. It never accepts a preview capability, browser
// identity selector, forwarded client identity, or a repository write grant.
export class HostedAccess implements HostedReadAccess {
  readonly origin: string;
  private sessions = new Map<string, Session>();
  private attempts: number[] = [];
  private absoluteMs: number;
  private idleMs: number;
  constructor(private options: HostedOptions, private now = Date.now) {
    const url = new URL(options.publicOrigin);
    if (url.protocol !== 'https:' || url.origin !== options.publicOrigin || url.username || url.password || !options.trustedProxyAddresses.length || options.trustedProxyAddresses.length > 8 || options.trustedProxyAddresses.some(ip => !isIP(ip)) || (options.accessKeySha256 !== undefined && !/^[a-f0-9]{64}$/.test(options.accessKeySha256))) throw new Error('Invalid hosted access configuration.');
    this.origin = url.origin;
    this.absoluteMs = options.sessionMs ?? 8 * 60 * 60 * 1000;
    this.idleMs = options.idleMs ?? 30 * 60 * 1000;
    if (!Number.isSafeInteger(this.absoluteMs) || this.absoluteMs < 1 || this.absoluteMs > 8 * 60 * 60 * 1000 || !Number.isSafeInteger(this.idleMs) || this.idleMs < 1 || this.idleMs > 30 * 60 * 1000) throw new Error('Invalid hosted session expiry.');
  }
  boundary(req: IncomingMessage) {
    const remote = req.socket.remoteAddress?.replace(/^::ffff:/, '');
    // The last proxy must overwrite Host/X-Forwarded-Proto and clear all other
    // forwarding headers. No user-controlled forwarding chain is interpreted.
    if (!remote || !this.options.trustedProxyAddresses.includes(remote) || req.headers.host !== new URL(this.origin).host || req.headers['x-forwarded-proto'] !== 'https' || req.headers['x-forwarded-host'] || req.headers['x-forwarded-for'] || req.headers.forwarded || req.headers['x-real-ip'] || (req.headers.origin !== undefined && req.headers.origin !== this.origin) || !['same-origin', 'none', undefined].includes(req.headers['sec-fetch-site'] as any)) problem('LOCAL_ORIGIN', 403, 'This Studio accepts its configured HTTPS proxy only.');
  }
  private prune() {
    const now = this.now();
    for (const [id, session] of this.sessions) if (now >= session.expires || now >= session.idle) this.sessions.delete(id);
  }
  private current(req: IncomingMessage, touch = false) {
    this.prune();
    const cookies = (req.headers.cookie ?? '').split(';').map(c => c.trim()).filter(c => c.startsWith(cookieName + '='));
    if (cookies.length !== 1) return undefined;
    const id = cookies[0].slice(cookieName.length + 1), session = this.sessions.get(id);
    if (!session || !/^[A-Za-z0-9_-]{43}$/.test(id)) return undefined;
    if (touch) session.idle = Math.min(session.expires, this.now() + this.idleMs);
    return { id, session };
  }
  status(req: IncomingMessage) {
    const current = this.current(req);
    return { mode: 'hosted-read-only', configured: !!this.options.accessKeySha256, authenticated: !!current, csrf: current?.session.csrf ?? null };
  }
  require(req: IncomingMessage) {
    if (!this.options.accessKeySha256) problem('HOST_NOT_CONFIGURED', 503, 'The owner must configure protected Studio sign-in on the host.');
    const current = this.current(req, true);
    if (!current) problem('SESSION_REQUIRED', 401, 'Sign in to Studio again.');
    if (req.method === 'POST' && !equal(String(req.headers['x-studio-csrf'] ?? ''), current.session.csrf)) problem('LOCAL_ORIGIN', 403, 'The Studio session requires its current request token.');
  }
  login(req: IncomingMessage, res: ServerResponse, input: unknown) {
    if (!this.options.accessKeySha256) problem('HOST_NOT_CONFIGURED', 503, 'The owner must configure protected Studio sign-in on the host.');
    const now = this.now();
    this.attempts = this.attempts.filter(time => now - time < 60_000);
    if (this.attempts.length >= 10) problem('LOGIN_LIMIT', 429, 'Wait before trying Studio sign-in again.');
    this.attempts.push(now);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'access_key')) problem('INVALID_INPUT', 400, 'Studio sign-in accepts one access key.');
    const key = (input as { access_key: unknown }).access_key;
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(key) || !equal(createHash('sha256').update(key).digest('hex'), this.options.accessKeySha256)) problem('SESSION_REQUIRED', 401, 'Studio sign-in was not accepted.');
    this.prune();
    const old = this.current(req); if (old) this.sessions.delete(old.id);
    if (this.sessions.size >= 32) problem('LOGIN_LIMIT', 429, 'Studio has reached its session limit.');
    const id = token(), session = { csrf: token(), expires: now + this.absoluteMs, idle: now + Math.min(this.idleMs, this.absoluteMs) };
    this.sessions.set(id, session);
    res.setHeader('set-cookie', `${cookieName}=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(this.absoluteMs / 1000)}`);
    return { mode: 'hosted-read-only', configured: true, authenticated: true, csrf: session.csrf };
  }
  logout(req: IncomingMessage, res: ServerResponse) {
    this.require(req);
    const current = this.current(req); if (current) this.sessions.delete(current.id);
    res.setHeader('set-cookie', `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
    return { authenticated: false };
  }
  clear() { this.sessions.clear(); }
}
