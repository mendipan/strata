import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { r1CompletionReceiptSchema } from '../src/reconciliation-completion-r1.js';

// Separate generator preserves the existing runtime schema map and immutable formats.
await writeFile('schemas/reconciliation-completion-r1.schema.json', JSON.stringify(z.toJSONSchema(r1CompletionReceiptSchema), null, 2) + '\n');
