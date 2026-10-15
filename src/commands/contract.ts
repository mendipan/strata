import { z } from 'zod';
import { parse } from '../model.js';
import { adoptionPrepareInput, adoptionReviewInput } from '../adoption/persistent.js';
import { revalidationRequestSchema } from '../revalidation.js';
import { BUILD_OPERATION_SCHEMAS } from '../build-operations.js';
import { PROFILE_OPERATION_SCHEMAS } from '../profile-service.js';
const ref=z.string().regex(/^[A-Za-z0-9_.-]+@[A-Za-z0-9_-]+$/).max(256), record=z.unknown(), refs=z.array(ref).max(100);
const schemas:Record<string,z.ZodType>={
  ...PROFILE_OPERATION_SCHEMAS, ...BUILD_OPERATION_SCHEMAS,
  'drift.revalidate':revalidationRequestSchema,
  'mediation.install':z.object({baseline:ref}).strict(),
  'evidence.run':z.object({target:ref,slot:z.string().min(1).max(128),profile:z.string().min(1).max(128)}).strict(),
  'criterion.review':z.object({realization:ref,criterion:z.object({check:z.string(),version:z.string(),fixture:z.string(),method:z.literal('review')}).strict(),accepted:z.boolean(),rationale:z.string().min(1).max(10000)}).strict(),
  init:z.object({record}).strict(),
  'layer.create':z.object({record}).strict(),
  'layer.revise':z.object({record,previous:ref}).strict(),
  'layer.restore':z.object({ref,from:ref}).strict(),
  'layer.publish':z.object({ref,review:z.unknown().optional(),authoring_review:ref.optional(),adoption_review:ref.optional()}).strict(),
  'adoption.prepare':adoptionPrepareInput,
  'adoption.review':adoptionReviewInput,
  'content.review':z.object({record}).strict(),
  compose:z.object({record}).strict(),
  resolve:z.object({record}).strict(),
  approve:z.object({record}).strict(),
  materialize:z.object({target:ref,profile:z.string().min(1).max(128)}).strict(),
  'realization.register':z.object({record}).strict(),
  validate:z.object({target:ref,realization:ref,evidence:z.unknown()}).strict(),
  release:z.object({target:ref,validation:ref,approvals:refs}).strict(),
};
export function validateCommandInput(command:string,input:unknown){if(schemas[command])parse(schemas[command],input);}
