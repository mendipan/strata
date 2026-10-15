import { problem, type ConnectionConfig } from './contract.js';
import type { ReviewDraftGrant } from './read.js';

// These are trusted local-host arguments. Browser queries cannot change them.
export function parseExplorerArgs(args: string[]) {
  const booleans = ['--sample', '--check-config', '--allow-remote-read', '--help'];
  const values = ['--config', '--port', '--expect-repository-id', '--review-draft', '--review-sha256'];
  const parsed = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (parsed.has(flag) || ![...booleans, ...values].includes(flag)) throw new Error('Unknown or duplicate Studio argument.');
    if (booleans.includes(flag)) parsed.set(flag, 'true');
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('Missing Studio argument.');
      parsed.set(flag, value);
    }
  }
  const configPath = parsed.get('--config');
  const sample = parsed.has('--sample');
  const checkConfig = parsed.has('--check-config');
  const allowRemoteRead = parsed.has('--allow-remote-read');
  const expectedRepositoryId = parsed.get('--expect-repository-id');
  const reviewRef = parsed.get('--review-draft');
  const reviewSha256 = parsed.get('--review-sha256');
  const portText = parsed.get('--port') ?? '4173';
  if (!/^\d+$/.test(portText) || +portText > 65535) throw new Error('Invalid loopback port.');
  if (sample && configPath) throw new Error('Choose one explicit source.');
  if ((checkConfig || allowRemoteRead || expectedRepositoryId || reviewRef || reviewSha256) && !configPath) throw new Error('A trusted connection config is required.');
  if (expectedRepositoryId && !/^[A-Za-z0-9_-]{1,256}$/.test(expectedRepositoryId)) throw new Error('Invalid repository ID.');
  if (reviewRef || reviewSha256) {
    if (!expectedRepositoryId || !reviewRef || !reviewSha256 || !/^[A-Za-z0-9_.-]+@[A-Za-z0-9_-]+$/.test(reviewRef) || reviewRef.length > 256 || !/^[a-f0-9]{64}$/.test(reviewSha256)) throw new Error('Draft review requires an exact reference, hash and repository ID.');
  }
  return { sample, configPath, checkConfig, allowRemoteRead, expectedRepositoryId, reviewRef, reviewSha256, port: +portText, help: parsed.has('--help') };
}

export function reviewGrant(config: ConnectionConfig, options: ReturnType<typeof parseExplorerArgs>): ReviewDraftGrant | undefined {
  if (!options.reviewRef) return undefined;
  // The draft grant never outlives the independently authorized source read.
  if (Date.parse(config.read_authorization.expires_at) <= Date.now()) problem('SOURCE_AUTH', 403, 'Draft review authorization needs attention.');
  return { project_id: config.project_id, ref: options.reviewRef, sha256: options.reviewSha256!, expires_at: config.read_authorization.expires_at };
}
