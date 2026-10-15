import { z } from 'zod';
import { parse } from './model.js';
import type { SecurityContext } from './security.js';
import type { LocalBuildRepository } from './build-repository-node.js';
import { BUILD_OPERATIONS } from './build-operations.js';
import { PROFILE_OPERATIONS } from './build-records.js';
import { presentOperationEffects } from './commands/replay-effects.js';

export const PROFILES_BUILD_COMMANDS = [...PROFILE_OPERATIONS, ...BUILD_OPERATIONS] as const;
export const isProfilesBuildCommand = (command: string) => (PROFILES_BUILD_COMMANDS as readonly string[]).includes(command);
export const studioRequestSchema = z.object({ command: z.enum(PROFILES_BUILD_COMMANDS), input: z.record(z.string(), z.unknown()),
  idempotency_key: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/), expected_generation: z.string().regex(/^[a-f0-9]{64}$/),
  expected_policy: z.string().min(1).max(256), dry_run: z.boolean().optional() }).strict();
/** Host ports may support profile persistence independently of Local output. */
export interface ProfilesBuildStudioPort {
  repository: { repository_id: string };
  supports?(command: string): boolean;
  read(command: string, input: unknown): Promise<any>;
  operation(value: unknown): Promise<any>;
  download(build_id: string, file_id: string): Promise<any>;
}
/** Uses the existing host actor resolver and repository adapter, with no UI storage. */
export class LocalBuildStudioAdapter {
  constructor(readonly repository: LocalBuildRepository, private readonly context: () => SecurityContext) {}
  async read(command: string, input: unknown) { return (await this.repository.execute(command, input, this.context())).data; }
  async operation(value: unknown) {
    const request = parse(studioRequestSchema, value), context = this.context();
    const result = presentOperationEffects(await this.repository.execute(request.command, request.input, context, {
      key: request.idempotency_key, expected_generation: request.expected_generation, expected_policy: request.expected_policy, dry_run: request.dry_run,
    }));
    let generation: string | null = null, refresh_error: string | null = null;
    try { generation = (await this.repository.snapshot(this.context())).generation; }
    catch (error: any) { refresh_error = error.code ?? 'SOURCE_UNAVAILABLE'; }
    return { data: result.data, created: result.created, operation_id: result.operation_id, reused: result.reused ?? false, refresh_error, generation };
  }
  async download(build_id: string, file_id: string) { return this.repository.download(build_id, file_id, this.context()); }
}
export function profilesBuildCapabilityRows(configured: boolean, supports: (command: string) => boolean = () => configured) {
  return PROFILES_BUILD_COMMANDS.map(operation => ({ operation, configured: configured && supports(operation), supported: configured && supports(operation),
    ...(configured && supports(operation) ? {} : { code: 'LOCAL_BUILD_BACKEND_NOT_CONFIGURED', reason: 'This host has no configured transaction or output adapter for this operation.' }) }));
}
