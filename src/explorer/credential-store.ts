import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { noLinks } from '../node-state.js';
import { ExplorerError, problem, safeJson } from './contract.js';
import { trustedFile } from './source.js';

export const CREDENTIAL_ID = 'artifacts-api-token' as const;
const FORMAT = 'strata-studio-credential-file/1';
const LIMIT = 64 * 1024;
const proof = z.string().regex(/^[a-f0-9]{64}$/);
const testResultSchema = z.object({ outcome: z.enum(['passed', 'denied', 'unavailable', 'error']), verified_at: z.string().datetime() }).strict();
const entrySchema = z.object({ value: z.string().min(1).max(512).regex(/^[\x21-\x7e]+$/), updated_at: z.string().datetime() }).strict();
const stateSchema = z.object({ format: z.literal(FORMAT), revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1), credential: entrySchema.nullable(), last_test: testResultSchema.nullable(), receipts: z.array(z.object({ request_id: z.string().uuid(), digest: proof, test: testResultSchema.optional() }).strict()).max(32) }).strict();
const frameSchema = z.object({ format: z.literal(FORMAT), cipher: z.literal('AES-256-GCM'), iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/), tag: z.string().regex(/^[A-Za-z0-9_-]{22}$/), data: z.string().min(1).max(LIMIT).regex(/^[A-Za-z0-9_-]+$/) }).strict();
type State = z.infer<typeof stateSchema>;
export type CredentialTest = z.infer<typeof testResultSchema>;
export type StoreAction = { action: 'save' | 'remove' | 'test'; credential_id: typeof CREDENTIAL_ID; revision: number; request_id: string; value?: string };
export type StoreMetadata = { revision: number; credentials: { id: typeof CREDENTIAL_ID; configured: boolean; updated_at: string | null }[]; last_test: CredentialTest | null };
const empty = (): State => ({ format: FORMAT, revision: 0, credential: null, last_test: null, receipts: [] });
const unavailable = () => problem('CREDENTIAL_STORE_UNAVAILABLE', 503, 'The protected credential store needs owner attention.');
const metadata = (state: State): StoreMetadata => ({ revision: state.revision, credentials: [{ id: CREDENTIAL_ID, configured: !!state.credential, updated_at: state.credential?.updated_at ?? null }], last_test: state.last_test });

/** Small encrypted credential file. OS administrators and the running host are
 * trusted; ciphertext is not protection against an administrator with the key.
 * Plaintext is never exposed by metadata/actions. It is available only through
 * the server-injected provider callback, after the caller checks its read grant.
 */
export class EncryptedCredentialStore {
  readonly file: string;
  constructor(readonly directory: string, private unlockKey: () => Promise<Uint8Array | undefined>, private initialized = false) {
    if (!path.isAbsolute(directory)) throw new Error('Credential storage requires an absolute private directory.');
    this.file = path.join(directory, 'credentials.enc');
  }
  private async key() {
    const supplied = await this.unlockKey();
    if (!supplied) problem('CREDENTIAL_STORE_LOCKED', 503, 'The owner must provision the separate credential-store unlock key.');
    if (supplied.length !== 32) return unavailable();
    return Buffer.from(supplied);
  }
  private async privateDirectory(create = false) {
    await noLinks(this.directory);
    if (create) {
      // The parent must already be an owner-approved private state directory.
      const parent = await lstat(path.dirname(this.directory));
      if (!parent.isDirectory() || (process.platform !== 'win32' && (parent.mode & 0o077))) return unavailable();
      try { await mkdir(this.directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      if (process.platform !== 'win32') { const parentDirectory = await open(path.dirname(this.directory), 'r'); try { await parentDirectory.sync(); } finally { await parentDirectory.close(); } }
    }
    try {
      const stat = await lstat(this.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) return unavailable();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || create) throw error; }
  }
  private async read(key: Buffer): Promise<State> {
    await this.privateDirectory();
    try {
      const stat = await lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) return unavailable();
      const frame = frameSchema.parse(safeJson(await trustedFile(this.file, LIMIT), LIMIT));
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(frame.iv, 'base64url'), { authTagLength: 16 });
      decipher.setAAD(Buffer.from(FORMAT)); decipher.setAuthTag(Buffer.from(frame.tag, 'base64url'));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(frame.data, 'base64url')), decipher.final()]);
      try { return stateSchema.parse(safeJson(new TextDecoder('utf-8', { fatal: true }).decode(plaintext), LIMIT)); }
      finally { plaintext.fill(0); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !this.initialized) return empty();
      if (error instanceof ExplorerError && error.code === 'CREDENTIAL_STORE_LOCKED') throw error;
      return unavailable();
    }
  }
  async status(): Promise<StoreMetadata> {
    const key = await this.key();
    try { return metadata(await this.read(key)); } finally { key.fill(0); }
  }
  // A server-only authority generation check. It never unlocks/decrypts or
  // creates the credential file, so I/O admission can precede secret access.
  async encryptedGeneration():Promise<string>{
    try{await this.privateDirectory();const meta=await lstat(this.file);if(!meta.isFile()||meta.nlink!==1||process.platform!=='win32'&&(meta.mode&0o077))return unavailable();
      const text=await trustedFile(this.file,LIMIT);frameSchema.parse(safeJson(text,LIMIT));return createHash('sha256').update(text).digest('hex');
    }catch{return unavailable();}
  }
  // Enrollment only: exclusive initialization under the installation lease.
  async initialize() {
    await this.privateDirectory(true);
    try { await lstat(this.file); return unavailable(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const key = await this.key(); try { await this.write(key, empty()); this.initialized = true; } finally { key.fill(0); }
  }
  // Server-only interface, never called from a generic browser/provider URL.
  async withCredential<T>(operation: (credential: string | undefined) => Promise<T>): Promise<T> {
    const key = await this.key();
    try { const state = await this.read(key); return await operation(state.credential?.value); }
    finally { key.fill(0); }
  }
  private async lease() {
    await this.privateDirectory(true);
    const file = path.join(this.directory, '.credential-store.lock'); await noLinks(file);
    let handle;
    try { handle = await open(file, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') problem('CREDENTIAL_BUSY', 409, 'Credential storage is busy. A stale lease needs owner reconciliation.', true);
      return unavailable();
    }
    try { await handle.writeFile(JSON.stringify({ format: 'strata-credential-lease/1', pid: process.pid })); }
    catch { await handle.close(); await unlink(file); return unavailable(); }
    return async () => { await handle.close(); await unlink(file); };
  }
  private async write(key: Buffer, state: State) {
    const iv = Buffer.from(randomBytes(12)), cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(FORMAT));
    const plaintext = Buffer.from(JSON.stringify(state));
    let encrypted: Buffer;
    try { encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]); }
    finally { plaintext.fill(0); }
    const body = JSON.stringify({ format: FORMAT, cipher: 'AES-256-GCM', iv: iv.toString('base64url'), tag: Buffer.from(cipher.getAuthTag()).toString('base64url'), data: Buffer.from(encrypted).toString('base64url') });
    if (Buffer.byteLength(body) > LIMIT) return unavailable();
    const temporary = path.join(this.directory, '.credentials-' + Buffer.from(randomBytes(16)).toString('hex'));
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(body); await handle.sync(); }
    catch (error) { await handle.close(); await unlink(temporary); throw error; }
    await handle.close();
    try {
      await noLinks(this.file); await rename(temporary, this.file);
      if (process.platform !== 'win32') { const directory = await open(this.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); } }
    } catch (error) { try { await unlink(temporary); } catch {} throw error; }
  }
  async action(action: StoreAction, tester?: (signal: AbortSignal) => Promise<CredentialTest>, authorize?: () => Promise<void>): Promise<StoreMetadata & { replayed: boolean; test?: CredentialTest }> {
    const key = await this.key();
    let release: (() => Promise<void>) | undefined;
    try {
      release = await this.lease(); await authorize?.(); const state = await this.read(key);
      const digest = createHash('sha256').update(JSON.stringify({ action: action.action, credential_id: action.credential_id, revision: action.revision, value: action.value ?? null })).digest('hex');
      const previous = state.receipts.find(receipt => receipt.request_id === action.request_id);
      if (previous) {
        if (previous.digest !== digest) problem('REQUEST_CONFLICT', 409, 'This credential request ID was used for a different action.');
        return { ...metadata(state), replayed: true, ...(previous.test ? { test: previous.test } : {}) };
      }
      if (action.revision !== state.revision) problem('CREDENTIAL_CHANGED', 409, 'The credential store changed. Refresh status before another action.', true);
      if (state.revision >= Number.MAX_SAFE_INTEGER - 1) return unavailable();
      let test: CredentialTest | undefined;
      if (action.action === 'save') {
        const value = entrySchema.parse({ value: action.value, updated_at: new Date().toISOString() });
        state.credential = value; state.last_test = null;
      } else if (action.action === 'remove') { state.credential = null; state.last_test = null; }
      else {
        if (!state.credential) problem('CREDENTIAL_TEST_UNAVAILABLE', 503, 'Save a provider credential before testing its bounded project connection.');
        if (!tester) problem('CREDENTIAL_TEST_UNAVAILABLE', 503, 'Configure a trusted project and bounded read authorization before testing.');
        // Timeout sanitizes the result; the injected transport must observe the
        // signal. The timer bounds this operation even if an adapter ignores it.
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([tester(controller.signal), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('deadline')); }, 10000); })]);
          test = testResultSchema.parse(result);
        } catch (error) { test = { outcome: error instanceof ExplorerError && error.code === 'SOURCE_AUTH' ? 'denied' : 'error', verified_at: new Date().toISOString() }; }
        finally { if (timer) clearTimeout(timer); controller.abort(); }
        state.last_test = test;
      }
      state.revision++;
      state.receipts.push({ request_id: action.request_id, digest, ...(test ? { test } : {}) }); state.receipts = state.receipts.slice(-32);
      await authorize?.(); await this.write(key, state);
      return { ...metadata(state), replayed: false, ...(test ? { test } : {}) };
    } catch (error) { if (error instanceof ExplorerError) throw error; return unavailable(); }
    finally { try { await release?.(); } finally { key.fill(0); } }
  }
}
