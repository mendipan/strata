import { z } from 'zod';
import { parse } from './model.js';
import { buildSelectionSchema, buildStartInputSchema, buildPinSchema, BUILD_LIMITS } from './build-contracts.js';
import { PROFILE_OPERATION_SCHEMAS } from './profile-service.js';

export const BUILD_READS = ['build.context', 'build.prepare', 'build.inspect', 'build.outputs'] as const;
export const BUILD_MUTATIONS = ['build.start'] as const;
export const BUILD_OPERATIONS = [...BUILD_READS, ...BUILD_MUTATIONS] as const;
// Recovery is an installation-startup seam, never a public operation.
export const BUILD_RECOVERY_OPERATION = 'build.reconcile' as const;
export const LOCAL_BUILD_OPERATIONS = [...Object.keys(PROFILE_OPERATION_SCHEMAS), ...BUILD_OPERATIONS, 'operation.inspect', 'studio.snapshot', 'capabilities'];
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const BUILD_OPERATION_SCHEMAS = {
  'build.context': z.object({ release_ref: buildPinSchema.shape.ref.optional(), limit: z.number().int().min(1).max(BUILD_LIMITS.page).optional(), cursor: buildPinSchema.shape.ref.optional() }).strict(),
  'build.prepare': buildSelectionSchema,
  'build.start': buildStartInputSchema,
  'build.inspect': z.object({ build_id: hash }).strict(),
  'build.outputs': z.object({ build_id: hash }).strict(),
};
export const BUILD_HOST_READ_SCHEMAS = {
  'operation.inspect': z.object({ key: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/) }).strict(),
  'studio.snapshot': z.object({}).strict(),
  'capabilities': z.object({ target: buildPinSchema.shape.ref.optional() }).strict(),
};
export function parseLocalBuildOperation(command: string, value: unknown): any {
  const schemas: Record<string, z.ZodType> = { ...PROFILE_OPERATION_SCHEMAS, ...BUILD_OPERATION_SCHEMAS, ...BUILD_HOST_READ_SCHEMAS };
  return schemas[command] ? parse(schemas[command], value) : null;
}
