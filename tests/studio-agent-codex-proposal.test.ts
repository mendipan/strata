import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { proposalSchema } from "../src/studio-agents/protocol.js";
import { codexProposalOutputSchema, parseCodexProposal } from "../src/studio-agents/codex-proposal.js";

function strictProviderShape(schema: any): void {
  assert.equal(schema.oneOf, undefined, "oneOf caused the real provider refusal");
  assert.ok(schema.type || schema.anyOf, "untyped schema is not a strict provider field");
  if (schema.anyOf) schema.anyOf.forEach(strictProviderShape);
  if (schema.type === "object") {
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
    Object.values(schema.properties).forEach(strictProviderShape);
  }
  if (schema.type === "array") strictProviderShape(schema.items);
}
const wire = (value: unknown = "After", before: unknown = "Before") => ({
  format: "strata-codex-draft-proposal/1", baseline: "R0@1", context_sha256: "a".repeat(64),
  intent: "Clarify purpose", questions: [], changes: [{ op: "set_item", block: "root", path: "purpose",
    expected: { kind: "value", value_json: JSON.stringify(before) }, value_json: JSON.stringify(value) }],
});

test("Codex output schema satisfies strict provider shape; original schema reproduces refusal", () => {
  assert.throws(() => strictProviderShape(z.toJSONSchema(proposalSchema)), /oneOf/);
  const schema = codexProposalOutputSchema();
  assert.equal(schema.type, "object");
  assert.equal(schema.anyOf, undefined);
  strictProviderShape(schema);
});

test("Codex JSON transport preserves values and canonical expected forms", () => {
  for (const value of ["quoted \"text\"\n", null, false, 12.5, [1, "two", null],
    { statement: "Rule", parameters: { arbitrary: [true, { nested: 3 }] } }]) {
    const decoded = parseCodexProposal(JSON.stringify(wire(value, value)), 65536);
    assert.deepEqual(decoded.changes[0].value, value);
    assert.deepEqual(decoded.changes[0].expected, { kind: "value", value });
    assert.equal(decoded.format, "strata-agent-draft-proposal/1");
    assert.deepEqual(parseCodexProposal(JSON.stringify(decoded), 65536), decoded);
  }
  for (const expected of [{ kind: "absent" }, { kind: "fingerprint", fingerprint: "b".repeat(64) }]) {
    const input: any = wire(); input.changes[0].expected = expected;
    assert.deepEqual(parseCodexProposal(JSON.stringify(input), 65536).changes[0].expected, expected);
  }
});

test("Codex transport rejects malformed or oversized output and preserves canonical restrictions", () => {
  for (const mutate of [
    (p: any) => { p.changes[0].value_json = "not JSON"; },
    (p: any) => { p.changes[0].expected.value_json = "undefined"; },
    (p: any) => { p.changes[0].expected = { kind: "absent", value_json: "null" }; },
    (p: any) => { p.changes[0].value = "extra canonical field"; },
    (p: any) => { p.changes[0].path = "authorities.release"; },
    (p: any) => { p.changes = []; },
    (p: any) => { p.changes = Array(26).fill(p.changes[0]); },
    (p: any) => { p.format = "unknown"; },
  ]) {
    const input = wire(); mutate(input);
    assert.throws(() => parseCodexProposal(JSON.stringify(input), 65536));
  }
  assert.throws(() => parseCodexProposal(JSON.stringify(wire("x".repeat(2000))), 1024));
  const question: any = wire(); question.changes = []; question.questions = ["Clarify intent?"];
  assert.equal(parseCodexProposal(JSON.stringify(question), 65536).questions.length, 1);
});
