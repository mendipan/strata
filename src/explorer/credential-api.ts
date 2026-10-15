import { createHash, timingSafeEqual } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ExplorerError, problem } from './contract.js';
import { CREDENTIAL_ID, EncryptedCredentialStore, type CredentialTest } from './credential-store.js';
import { trustedFile } from './source.js';

const common = {
  credential_id: z.literal(CREDENTIAL_ID), revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  request_id: z.string().uuid(), owner_authorization: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
};
export const credentialActionSchema = z.discriminatedUnion('action', [
  z.object({ ...common, action: z.literal('save'), value: z.string().min(1).max(512).regex(/^[\x21-\x7e]+$/) }).strict(),
  z.object({ ...common, action: z.literal('remove') }).strict(),
  z.object({ ...common, action: z.literal('test') }).strict(),
]);
export type CredentialAction = z.infer<typeof credentialActionSchema>;
// Future HostIssuer adapters must check a *separate* current manager privilege,
// principal/project/policy generations. Shared reader or authoring grants alone
// cannot satisfy this server-injected authorization interface.
export type CredentialAuthorityContext = { mode: 'owner-key-per-action' } | { mode: 'named-manager'; account_id: string; principal_id: string; project_id: string; authentication_generation: string; policy_generation: string };
export type CredentialAuthorization = (action: CredentialAction, context: CredentialAuthorityContext) => Promise<void>;
export type CredentialStatus = {
  format: 'strata-studio-credentials/1'; state: 'unconfigured' | 'locked' | 'ready' | 'error'; revision: number | null;
  credentials: { id: typeof CREDENTIAL_ID; configured: boolean | null; updated_at: string | null }[];
  management: { state: 'unconfigured' | 'required'; authorization: 'owner-key-per-action' };
  capabilities: { save: boolean; remove: boolean; test: boolean };
  last_test: CredentialTest | null; error?: { code: string; message: string };
};
export class CredentialApi {
  constructor(private options: { store?: EncryptedCredentialStore; authorize?: CredentialAuthorization; managerAvailable?: () => Promise<boolean>; tester?: (signal: AbortSignal) => Promise<CredentialTest>; changed?: () => Promise<void> } = {}) {}
  async status(): Promise<CredentialStatus> {
    let managerAvailable = !!this.options.authorize;
    if (this.options.managerAvailable) { try { managerAvailable = await this.options.managerAvailable(); } catch { managerAvailable = false; } }
    const result: CredentialStatus = {
      format: 'strata-studio-credentials/1', state: 'unconfigured', revision: null,
      credentials: [{ id: CREDENTIAL_ID, configured: null, updated_at: null }],
      management: { state: managerAvailable ? 'required' : 'unconfigured', authorization: 'owner-key-per-action' },
      capabilities: { save: false, remove: false, test: false }, last_test: null,
    };
    if (!this.options.store) return result;
    try {
      const data = await this.options.store.status();
      return { ...result, ...data, state: 'ready', capabilities: { save: managerAvailable, remove: managerAvailable, test: managerAvailable && !!this.options.tester && data.credentials[0].configured } };
    } catch (error) {
      const locked = error instanceof ExplorerError && error.code === 'CREDENTIAL_STORE_LOCKED';
      return { ...result, state: locked ? 'locked' : 'error', error: { code: locked ? 'CREDENTIAL_STORE_LOCKED' : 'CREDENTIAL_STORE_UNAVAILABLE', message: locked ? 'The owner must provision the separate credential-store unlock key.' : 'The protected credential store needs owner attention.' } };
    }
  }
  async action(input: unknown, context: CredentialAuthorityContext = { mode: 'owner-key-per-action' }): Promise<CredentialStatus & { replayed: boolean; test?: CredentialTest }> {
    const parsed = credentialActionSchema.safeParse(input);
    if (!parsed.success) problem('INVALID_INPUT', 400, 'Credentials accept one bounded action, current revision, request ID and separate owner authorization.');
    if (!this.options.authorize) problem('CREDENTIAL_MANAGEMENT_REQUIRED', 403, 'The owner must provision separate credential-management authorization.');
    // Authorization precedes key access, decryption, filesystem mutation or
    // provider dispatch; it is repeated even for an idempotent action replay.
    await this.options.authorize(parsed.data, context);
    if (!this.options.store) problem('CREDENTIAL_STORE_LOCKED', 503, 'The owner must configure protected encrypted credential storage.');
    const { owner_authorization: _proof, ...action } = parsed.data;
    const result = await this.options.store.action(action, this.options.tester);
    if (action.action !== 'test') await this.options.changed?.();
    return { ...await this.status(), replayed: result.replayed, ...(result.test ? { test: result.test } : {}) };
  }
}

export const credentialStoreConfigSchema = z.object({ directory: z.string(), unlock_key_file: z.string(), manager_key_hash_file: z.string() }).strict();
export type CredentialStoreConfig = z.infer<typeof credentialStoreConfigSchema>;
async function protectedFile(filename: string, limit: number) {
  const value = await trustedFile(filename, limit);
  const metadata = await lstat(filename);
  if (metadata.isSymbolicLink() || (process.platform !== 'win32' && ((metadata.mode & 0o077) || (metadata.uid !== process.getuid?.() && metadata.uid !== 0)))) problem('CREDENTIAL_STORE_UNAVAILABLE', 503, 'The protected credential files need owner attention.');
  return value.trim();
}
export function fileCredentialComponents(config: CredentialStoreConfig) {
  const values = [config.directory, config.unlock_key_file, config.manager_key_hash_file];
  if (values.some(value => !path.isAbsolute(value)) || new Set(values).size !== 3) throw new Error('Credential storage requires distinct absolute host paths.');
  // Key material is delivered outside the encrypted data directory. No local
  // colocated plaintext unlock-key fallback or auto key creation exists.
  const relative = path.relative(config.directory, config.unlock_key_file);
  if (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) throw new Error('The unlock key must be separate from the encrypted store.');
  const store = new EncryptedCredentialStore(config.directory, async () => {
    try { const key = await protectedFile(config.unlock_key_file, 128); if (!/^[A-Za-z0-9_-]{43}$/.test(key)) problem('CREDENTIAL_STORE_UNAVAILABLE', 503, 'The protected credential files need owner attention.'); return Buffer.from(key, 'base64url'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  });
  let attempts: number[] = [];
  const authorize: CredentialAuthorization = async (action, context) => {
    if (context.mode !== 'owner-key-per-action') problem('CREDENTIAL_MANAGEMENT_REQUIRED', 403, 'This host uses separate owner-key credential management only.');
    const now = Date.now(); attempts = attempts.filter(time => now - time < 60000);
    if (attempts.length >= 10) problem('CREDENTIAL_MANAGEMENT_REQUIRED', 429, 'Wait before trying credential-management authorization again.');
    attempts.push(now);
    let hash: string;
    try { hash = await protectedFile(config.manager_key_hash_file, 128); }
    catch { return problem('CREDENTIAL_MANAGEMENT_REQUIRED', 403, 'Credential-management authorization is not available.'); }
    if (!/^[a-f0-9]{64}$/.test(hash)) problem('CREDENTIAL_MANAGEMENT_REQUIRED', 403, 'Credential-management authorization is not available.');
    const actual = Buffer.from(createHash('sha256').update(action.owner_authorization).digest('hex')), expected = Buffer.from(hash);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) problem('CREDENTIAL_MANAGEMENT_REQUIRED', 403, 'Separate owner credential-management authorization is required.');
  };
  const managerAvailable = async () => {
    try { return /^[a-f0-9]{64}$/.test(await protectedFile(config.manager_key_hash_file, 128)); } catch { return false; }
  };
  return { store, authorize, managerAvailable };
}
