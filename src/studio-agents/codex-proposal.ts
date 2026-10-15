import { z } from "zod";
import { bounded, proposalSchema } from "./protocol.js";

// Provider transport only. Arbitrary canonical JSON cannot be expressed as a
// strict output object with a fixed set of required properties. Encoding it as
// JSON text preserves its types and keys without widening canonical admission.
const jsonValue = z.string().describe(
  'A complete JSON-encoded value. Encode strings with JSON quotes, e.g. "Purpose". Preserve object keys and value types.',
);
const expected = z.union([
  z.object({ kind: z.literal("absent") }).strict(),
  z.object({ kind: z.literal("value"), value_json: jsonValue }).strict(),
  z.object({ kind: z.literal("fingerprint"), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
const wireSchema = z.object({
  ...proposalSchema.shape,
  format: z.literal("strata-codex-draft-proposal/1"),
  changes: z.array(proposalSchema.shape.changes.element.omit({ expected: true, value: true }).extend({
    expected,
    value_json: jsonValue,
  })).max(25),
}).strict();

export function codexProposalOutputSchema() {
  return z.toJSONSchema(wireSchema);
}

export function parseCodexProposal(text: string, maxBytes: number) {
  const raw = JSON.parse(text);
  // Original-ID recovery must still admit retained canonical-format output
  // from earlier runners, subject to the same canonical validation.
  if (raw?.format === "strata-agent-draft-proposal/1")
    return bounded(proposalSchema, raw, maxBytes);
  const wire = bounded(wireSchema, raw, maxBytes);
  return bounded(proposalSchema, {
    ...wire,
    format: "strata-agent-draft-proposal/1",
    changes: wire.changes.map(({ value_json, expected: before, ...change }) => ({
      ...change,
      expected: before.kind === "value"
        ? { kind: "value", value: JSON.parse(before.value_json) }
        : before,
      value: JSON.parse(value_json),
    })),
  }, maxBytes);
}
