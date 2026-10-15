# V1-P: native Git version compatibility preparation

This slice provides a pure version contract, a strict history inspection packet and deterministic synthetic legacy fixtures. It enables no command, native v0.3 dispatch, migration, adapter, reconciliation completion or authority. Full V1 remains open.

The baseline is main `52ed675fb119b6fd8224d4131e7c911714d285ac`. The accepted S0 boundary remains the shared [authority interface](../src/security.ts), [command input contract](../src/commands/contract.ts), [named actor receipts/evidence](../src/auth/records.ts) and [hosted authority design](studio/HOSTED_WRITES.md). Existing [source binding](SOURCE_BINDING_CONTRACT.md), [native delivery](NATIVE_GIT_ADOPTION.md) and [selected adoption bridge](ADOPTION_SELECTED_GIT_BRIDGE.md) define the legacy proof paths. These files are unchanged by V1-P.

## Version contracts

[nativeGitVersionContract](../src/v1-p/native-git-contract.ts) describes these separate lanes:

| Model | Authority, binding and evidence | Native support |
| --- | --- | --- |
| v0.1 | Original local fixture trust; `source-binding/1`; unbridged `git-change-plan/1`, `git-acceptance/1`, `git-apply-review/1`; selected adoption uses plan/acceptance/review `/2`; both retain `git-finalization/1`. | Existing explicitly configured local Node delivery; V1-P adds only historical inspection. |
| v0.2 | No declared native Git binding/delivery contract. | Unsupported. |
| v0.3 | Fresh explicit project; named host authentication and exact retained auth/run/review closure required. Existing semantic forms include `strata-host-auth/1` and `strata-host-evidence/1`. Native record formats remain unassigned. | Unsupported; hosted collection acceptance does not establish native parity. |

Record format and model version are different axes. A legacy `/2` adoption bridge still belongs to v0.1 and has its own exact publication, source, evidence and reviewer closure. It is not a v0.3 native record. `V1_P_LEGACY_SCHEMAS` reexports the existing schema objects unchanged; it does not extend or normalize them.

Existing model-neutral `source.capture` and `source-snapshot/1` measurement can remain available through a configured Node repository backend. This does not provide v0.3 source acceptance, binding or native patch delivery. The current SDK lacks that application filesystem backend, and the named host's repository write/execution gates remain unconfigured.

The named lane requires server-derived actor/project/action/input/policy/grant receipts, current operation/repository/path/Block and baseline authority at dispatch and commit, exact Release/source/scope/stage/result-tree/owner-commit binding, and application-specific checker/fixture/oracle plus complete criteria/regressions. Mechanical outcomes need the retained authorized producer/run closure; reviews remain attributable attestations. Existing hosted semantic evidence alone supplies no application Git execution evidence. Historical validity uses retained receipts and hashes, while future writes separately require live authorization; historical records are never rewritten after revocation.

## Strict history inspection

[The JSON schema](../schemas/v1-p/native-git-history-contract.schema.json) describes `native-git-history-contract/1`. This is a standalone library packet, not an Engine record or command. Unknown fields fail. It pins the entire retained record map, original model/project/repository, exact source binding and snapshot, complete Release and snapshot digests, historical principal/scope/authority manifest, every declared application acceptance and its recorded producer trust, and the nullable exact finalization.

The inspection packet supports declared Git application acceptance refs in `/1` and `/2` formats. Bindings carrying other kinds of supporting acceptance refs retain their existing runtime/archive contracts and are outside this packet's current coverage; no conversion is attempted.

`inspectNativeGitHistory(packet, records)` accepts only `historical-inspection` of v0.1 in its original version. It checks typed published pins and full native/source digest refs, then uses the existing source/Git/adoption/drift history verifiers and pure semantic reader for retained closure. Existing private adoption and drift context retain their own historical contracts. This reuses their current verifiers and adds no reconciliation or R1 completion logic. It reads no filesystem or current issuer and runs no checker. Its result explicitly reports `execution_ready:false`, `authority_granted:false` and `migrated:false`. Archive export/restore still uses the existing [backup verifier](LOCAL_BACKUP.md), including checkpoint/profile/ownership/byte closure; this inspection is not an archive trust reactivation mechanism.

Semantic revision refs and legacy shortened semantic refs retain their existing identities; source/Git refs require full digest suffixes. Raw-byte SHA-256, scope/manifest/snapshot/record digests and object-format-bound Git OIDs remain separate domains, including when a SHA-256 Git OID has the same length as a semantic digest. No branch alias is resolved. No old record is copied to a new model, widened, relabelled or down-converted.

Refusals include dispatch, migration, reinterpretation, model retargeting, cross-version intent, wrong source/repository/Release/snapshot pins, substituted fixture authority, named authority promotion, hosted semantic evidence or observations replacing acceptance, producer/trust/format substitution, missing exact finalization and missing historical predecessors. Rehashing an incomplete record map does not repair its closure. V1-P refusal codes describe this library only; existing runtime error contracts are unchanged.

## Synthetic fixtures and focused verification

[The fixture pack](../tests/fixtures/v1-p/README.md) contains literal SHA-1 and SHA-256 bootstrap/successor histories with preserved artifact byte hashes, exact refs, original local trust, supplied patch/pre/postimages, application acceptance, review, apply receipt, owner-commit finalization and successor binding. All Git OIDs, commit claims and passing results are synthetic structural assertions. The generator invokes no Git process, application checker, broker, provider or named account. These fixtures never qualify native delivery or runtime behavior.

[The tests](../tests/v1-p-native-git-contracts.test.ts) compare golden bytes with deterministic regeneration, assert no input mutation, execute the literal refusal matrix, remove native and semantic predecessors after rehashing, exercise the existing inactive backup/restore path byte for byte and preserve the runtime `UNSUPPORTED_MODEL_VERSION` refusal for v0.3. Existing source/Git and selected bridge suites remain the regression gates for the current executable behavior.

From the checkout root, with the pinned dependencies available:

```powershell
npm run build
npm run typecheck
node --test --test-concurrency=1 dist/tests/v1-p-native-git-contracts.test.js dist/tests/source-binding.test.js dist/tests/git-adoption.test.js dist/tests/g2-bridge-contract.test.js dist/tests/g2-bridge-negatives.test.js dist/tests/g2-completion-proof.test.js
npm run check:links
```

Intentional fixture/schema regeneration uses `node dist/scripts/v1-p/generate-fixtures.js`; golden whole-file hashes in the test require explicit review when fixture bytes change. Refusal fixtures are hand-authored separately.

## Review and remaining dependencies

This slice owns only new `src/v1-p/`, `scripts/v1-p/`, `schemas/v1-p/`, `tests/fixtures/v1-p/`, its standalone test and this document. It changes no shared native dispatch, source/Git mutation, authority, schema generator, R1 or project-status file.

Astra approval is required before choosing native v0.3 binding/plan/evidence/review/finalization formats or their authenticated application run contract, adding host repository/path grants and dispatch, changing archive/runtime semantics, or defining any explicit migration workflow. This preparation assigns none of those formats and makes no architectural migration decision. Future integration also needs the separately assigned R1 completion contract, parity/qualification and applicable host/operator acceptance. R1 and hosted collection are later integration gates, independent of this preparation. Credentials, provider operations, deployment, T01/TLS recovery and ZCode dispatch are outside this slice.
