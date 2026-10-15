import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { S2_BUILD_SCHEMAS } from '../src/build.js';
// S2-only generator. S1 owns integrating these strict schemas into durable admission/backup.
for (const [name, schema] of Object.entries(S2_BUILD_SCHEMAS)) {
  await writeFile(`schemas/${name}.schema.json`, JSON.stringify(z.toJSONSchema(schema), null, 2) + '\n');
}
