# Adoption preparation and publication (A1/A2)

A1 is an independent library slice for agent/person-prepared adoption proposals. It validates supplied JSON and captured source metadata. It does not read an application filesystem, execute source, create engine records, authenticate a reviewer or publish a Layer.

A2 adds persistent preparation and interpretation review through an explicitly configured local Node v0.1 Git host. Read [the executable A2 workflow](ADOPTION_PUBLICATION.md) for exact commands, source freshness, revision, retry and archive rules. A1 remains the pure supplied-data library described below; its output alone grants no publication authority. Hosted v0.3 source adoption and an `adoption inspect` alias remain unavailable; use the ordinary `inspect` command for persisted record types.

## What is implemented

| Library | API and result |
|---|---|
| [Contract](../src/adoption/contract.ts) | Strict zod schemas for adoption-inventory/1 and adoption-proposal/1; deterministic normalization; content-addressed refs; supplied native source-snapshot/1 validation |
| [Coverage](../src/adoption/coverage.ts) | prepareAdoptionProposal / validateAdoptionProposal against a normal baseline and Layer; explicit scope blockers; conservation across inventory revision |
| [Packet](../src/adoption/packet.ts) | createAdoptionPacket for reviewing/revising prepared input; exact baseline items, draft, source pins and response contract; 16 KiB bound |
| [Capture comparison](../src/adoption/freshness.ts) | compareAdoptionSourceSnapshot compares two supplied immutable captures; equality establishes no live freshness or host authority |

A1 changes no shared operations. A2 integrates existing command, issuer, Node source and registry seams without adding profiles, agent execution, UI or hosting.

## Inventory shape and accounting

An inventory pins the exact project and source snapshot reference/digest. It declares `incremental` or `reconstruct_declared_scope`, its scope statement, units, five accounting sections, protected paths, exclusions, questions and limitations.

Each unit has:
- a stable ID and kind: behavior, interface, error, state or test;
- description, rationale and scope: adopted or outside;
- interpretation classification: observed or inferred;
- disposition: mapped, excluded or unknown;
- present ordinary source-file paths and their captured SHA256, plus captured dependency paths;
- exact semantic item and acceptance references, and optional unverified evidence references.

Observed is a source-linked assertion. Neither observed nor a referenced validation ID proves a test ran. Classification and disposition remain separate.

Each of the five accounting sections lists exactly its declared units, or supplies a nonblank reason for none declared. This makes omissions visible within a declared inventory; it cannot establish that an agent discovered every program behavior. Review of the boundary remains required.

Mapped units must name items and the complete acceptance set derived from those items in the proposed snapshot. Excluded/unknown units cannot carry mappings. Every excluded unit has one rationale. Every unknown unit has an unresolved question. Outside units cannot count as mapped adoption.

All supplied Layer changes and added criteria must link to adopted mapped units. Existing normal Layer preconditions, model, subject and reference checks are reused. Decision Layers are outside this preparation path.

Unit IDs, sets and source paths reject duplicates/aliases. Arrays are normalized deterministically without changing caller inputs. Portable source-path rules and byte/entry limits reuse the existing native source contract. Inventory records have a 1 MiB serialized bound; packet context has a separate 16 KiB bound. No token-count or model-comprehension claim is made.

## Route and readiness semantics

Incremental preparation does not require full-app distillation. Outside units remain visible with their exclusions/uncertainty, while adopted units need complete mappings. Questions touching adopted scope, and unscoped questions, block scope accounting.

Reconstruction uses the same pipeline with the independent output lane. All adopted in-scope units must be mapped with acceptance. In-scope exclusions and unknowns block completeness. Outside exclusions are legitimate only against the declared boundary. The claim is `complete_declared_scope`, never universal equivalence.

Coverage returns these independent fields:
- `declared_inventory_accounted`: all five sections and declared units are accounted for;
- `scope_accounted` and `scope_claim`: adopted mapping/question result;
- `interpretation_reviewed:false`;
- `source_fresh:false`, `freshness:not_checked`;
- `behavior_verified:false`, `referenced_evidence_verified:false`;
- `publication_ready:false`.

False freshness means it has not been established by this library. It does not declare the real filesystem stale. A matching capture comparison likewise returns `host_authority_verified:false`. Caller-supplied metadata cannot become a live measurement receipt.

Proposal linkage pins normalized inventory, source, exact baseline reference/snapshot, normal Layer ref/digest, advisory author and delivery lane. `validateAdoptionProposal` refuses any disagreement with supplied context. It does not resolve those refs from an engine store or validate current identity/Layer head. Those are A2 responsibilities.

Inventory revision conserves declared unit IDs. Keep a unit with explicit exclusion/unknown disposition instead of silently deleting it. Changed route/scope or source recapture needs a new explicitly reviewed inventory.

## Agent handoff

Packets contain relevant baseline obligation values/criteria, the prepared Layer, inventory, allowed captured file pins and protected paths. The host must separately provide authorized source access and any missing relevant consumers/context. The owner hint supplies no identity. All packet execution/write/publication/approval fields are false.

This packet supports review/revision of prepared intent. It launches no agent and does not automatically extract source behavior.

Synthetic prompt:

> Review the prepared inventory and Layer against the supplied exact baseline and source files. Keep the unrelated report outside adopted scope. Account for behavior, interfaces, errors, state and tests; identify uncertainty and request missing context. Return the inventory and a normal Layer. Source-linked observations and referenced evidence remain unverified. Do not execute source, contact providers, modify files, publish or approve.

## Local executable recipe

Prerequisites: repository tooling already installed, Node >=22, a checkout containing A1. No cloud access or new package is needed. Run from that checkout:

```powershell
npm run typecheck
npm run build
New-Item -ItemType Directory -Path .strata -Force | Out-Null
node --import ./tests/no-external-fetch.mjs --test --test-concurrency=1 dist/tests/adoption-contracts.test.js dist/tests/source-binding.test.js dist/tests/profile-separation.test.js
```

Expected: all selected tests pass; no application source is imported by A1. The profile suite executes only existing synthetic finite profile output in disposable local directories.

Inspect the pure example without creating engine records:

```powershell
@'
import { adoptionFixture } from "./dist/tests/adoption-fixture.js";
import { prepareAdoptionProposal } from "./dist/src/adoption/coverage.js";
import { createAdoptionPacket } from "./dist/src/adoption/packet.js";
const context = await adoptionFixture();
const prepared = prepareAdoptionProposal(context);
console.log(JSON.stringify({
  proposal_ref: prepared.proposal_ref,
  coverage: prepared.coverage,
  packet_sha256: createAdoptionPacket(context).packet_sha256
}, null, 2));
'@ | node --input-type=module
```

Expected invariants: selected_scope, scope_accounted true, changed item counter/requirements.limit, outside unit unadopted-report; all review/freshness/behavior/publication fields remain false. Repeating against identical fixture bytes yields identical proposal/packet hashes.

The test fixture reuses the existing finite counter intent as an isolated structural model example. Its source files and binary/text protected files are synthetic; A1 hashes them and never executes them. It is not an accepted source binding, measured conversion or application materialization.

Evidence to capture: source commit, compiler/test output, deterministic refs/report, negative stale/mapping/unknown results and protected fixture hashes. No actual user application is needed.

## A2 boundary

A2 implements private versioned inventory/proposal envelopes, owner interpretation reviews and publication observations; exact current owner/head/project/baseline and repository grants; trusted source remeasurement at dispatch, precommit and cached publication retry; schema/bypass refusals; and structural inactive archive closure. See the linked workflow and tests for the supported local path.

Existing historical records retain their prior contract. Adoption is explicit through a new owned revision (or a new named Layer), and requires a fresh native capture, inventory and review. An ordinary revision cannot strip the retained adoption requirement. Changed declared scope or delivery route uses a new Layer lineage. Same-scope recapture requires an explicit predecessor and retains declared unit IDs. No bulk legacy upgrade or source rebasing is implemented.

Native source authority currently supports Node/v0.1. A1 pure Layer checks explicitly support v0.1/v0.2 and refuse v0.3, including new Block lifecycle proposals. New models need their own complete inventory accounting contract; they cannot enter through a broader shared parser. A1 adds no SDK measured execution or hosted Git authority.

Successful A1 preparation is a useful prepared-proposal checkpoint. It is not persisted or published. Accepted behavior and Release still require the existing independent composition/evidence/approval gates.
