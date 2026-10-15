import { mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { BUILD_RECORD_SCHEMAS } from '../src/build-records.js';
import { policyStoreV4Schema } from '../src/auth/host-issuer.js';
// Supporting schemas only. Frozen S0 and historical schema files stay untouched.
await mkdir('schemas', { recursive: true });
for (const [name, schema] of Object.entries({
  'build-repository-auth': BUILD_RECORD_SCHEMAS['build-repository-auth'],
  'build-contract-review': BUILD_RECORD_SCHEMAS['build-contract-review'],
  'build-profile-archive': BUILD_RECORD_SCHEMAS['build-profile-archive'], 'host-policy-v4': policyStoreV4Schema
})) await writeFile('schemas/' + name + '.schema.json', JSON.stringify(z.toJSONSchema(schema), null, 2) + '\n');
