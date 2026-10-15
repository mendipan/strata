import { z } from 'zod';
import { Engine } from '../core.js';
import { digest, fail, parse } from '../model.js';
import type { AuthorityIssuer, SecurityContext } from '../security.js';
import { BuildProfileService, type ProfileServiceScope } from '../profile-service.js';
import { PROFILE_OPERATIONS } from '../build-records.js';
import { studioRequestSchema, type ProfilesBuildStudioPort } from '../build-studio.js';
import { presentOperationEffects } from '../commands/replay-effects.js';

/** Explicit host metadata in the sealed project manifest, never request JSON.
 * Existing manifests remain byte-identical and unconfigured. Operator activation
 * must separately supply a reviewed manifest/catalog binding and policy /4 scope.
 */
export const namespaceProfilesSchema = z.object({
  authority_ref: z.string().regex(/^[A-Za-z0-9_.-]+@[A-Za-z0-9_-]+$/).max(256),
}).strict();

/** Construct only inside the namespace broker's admitted registry transaction.
 * Reviews are resolved from the exact retained supporting closure; login does
 * not manufacture a review and no public operation accepts review claims.
 */
export function namespaceProfileService(engine: Engine, scope: ProfileServiceScope, context: SecurityContext, issuer: AuthorityIssuer) {
  if (context.trust_mode !== 'host_authenticated') fail('AUTHENTICATION_REQUIRED', 4, 'Namespace profiles require a current authenticated repository actor.');
  return new BuildProfileService(engine, { ...scope, review: scope.review ?? ((action, subject) => {
    const reviews = Object.entries(engine.records).filter(([, r]) => r.type === 'build-contract-review' && r.published &&
      r.data.project_id === scope.project_id && r.data.repository_id === scope.repository_id && r.data.action === action && r.data.subject_sha256 === subject);
    const first = reviews.sort(([a], [b]) => a.localeCompare(b))[0];
    return first ? { ref: first[0], sha256: digest(first[1].data) } : undefined;
  }) }, context, issuer);
}

export type NamespaceRepositoryCall = (command: string, input: unknown, options?: {
  idempotency_key?: string; expected_generation?: string; expected_policy?: string; dry_run?: boolean;
}) => Promise<any>;

/** Thin Studio port; persistence, replay, CAS, audit and provider bounds belong
 * to the existing namespace broker. It owns no filesystem or writer lease.
 */
export class NamespaceProfilesStudioAdapter implements ProfilesBuildStudioPort {
  readonly repository: { repository_id: string };
  constructor(repository_id: string, private readonly call: NamespaceRepositoryCall) { this.repository = { repository_id }; }
  supports(command: string) { return PROFILE_OPERATIONS.includes(command as any); }
  private supported(command: string) { if (!this.supports(command)) fail('UNSUPPORTED_CAPABILITY', 8, 'Namespace profile persistence does not configure Local Build output.'); }
  async read(command: string, input: unknown) { this.supported(command); return (await this.call(command, input)).data; }
  async operation(value: unknown) {
    const request = parse(studioRequestSchema, value); this.supported(request.command);
    const result = presentOperationEffects(await this.call(request.command, request.input, {
      idempotency_key: request.idempotency_key, expected_generation: request.expected_generation,
      expected_policy: request.expected_policy, dry_run: request.dry_run,
    }));
    let generation: string | null = null, refresh_error: string | null = null;
    try { generation = (await this.call('studio.snapshot', {})).data.generation; }
    catch (error: any) { refresh_error = error.code ?? 'SOURCE_UNAVAILABLE'; }
    return { data: result.data, created: result.created, operation_id: result.operation_id, reused: result.reused ?? false, refresh_error, generation };
  }
  async download(_build_id: string, _file_id: string): Promise<never> { fail('UNSUPPORTED_CAPABILITY', 8, 'Namespace profile persistence has no Local Build output adapter.'); }
}
