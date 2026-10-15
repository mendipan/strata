import { mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { BUILD_SCHEMAS } from '../src/build-contracts.js';
// Separate generator: no historical schema files are rewritten.
await mkdir('schemas', { recursive: true });
for (const [name, schema] of Object.entries(BUILD_SCHEMAS)) await writeFile(`schemas/${name}.schema.json`, JSON.stringify(z.toJSONSchema(schema), null, 2) + '\n');
