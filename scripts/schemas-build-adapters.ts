import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { BUILD_ATTEMPT_SCHEMAS } from '../src/build-attempt-records.js';
import { policyStoreV4Schema } from '../src/auth/host-issuer.js';
for (const [name, schema] of Object.entries({ ...BUILD_ATTEMPT_SCHEMAS, 'host-policy-v4': policyStoreV4Schema }))
  await writeFile('schemas/' + name + '.schema.json', JSON.stringify(z.toJSONSchema(schema), null, 2) + '\n');
