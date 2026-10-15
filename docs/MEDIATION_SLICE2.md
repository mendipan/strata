# Minimal mediation slice 2: local result

Completed 2026-10-04 after approval to include [the bounded prerequisite](MEDIATION_PREREQUISITE_REVIEW.md). The accepted plans and canonical model are unchanged. This is code compatibility and synthetic local fixture work; it creates no credentials, real account grants or authority to approve a real project Release, deploy or spend.

Run the mediation and publication suites described in [verification](VERIFICATION.md) for fresh results.

## Prerequisite result

The existing approval, validation and Release rules are reused for explicit v0.2. The active [approval/2 schema](../schemas/approval-v2.schema.json) binds project/model/baseline/authority, exact target/evidence, generation/expiry and selection response binding. Legacy approvals are refused for v0.2; v0.1 normalization and receipt formats remain unchanged. The active scope validator represents a fixed guardian's protected-item path, as the existing guardian rule requires. This repairs the unavailable prototype form's Block-only scope; the frozen S1 schema artifact remains byte-identical, and no issued record is rewritten.

Versioned Resolution and Release use existing whole-Layer partition, responsible-scope, fixed-guardian, separate Release, fresh realization/evidence and conservation checks. Ordinary candidate validation is still insufficient to publish. Unconfigured raw v0.2 engines remain unsupported; missing durable fixture state cannot reset a grant.

Backup2 now verifies the explicit v0.2 flattened Release, versioned approvals and finite mediation supporting-record closure, including complete source refs, policy/grant/receipt relationships, lineage, validation, profile and retained assets. Asset-bearing and full policy-mediated Releases round-trip through isolated inactive copies. Missing archive bytes/refs fail; an inactive restore refuses broker activation even with an explicitly supplied test issuer. Historical verification never activates descriptors or rechecks today's liveness against old Releases. The original 19 schema files remain byte-identical; 11 active/control schemas are added.

## Mediation result

[The booking selection adapter](../src/profiles/booking-selection.ts) implements the one fixed evaluator, `booking-reminder-selection/1`; [mediation.ts](../src/mediation.ts) retains the generic control and authorization gates. Its reviewed fixture snapshot pins an exact fresh baseline, authority, scenario and published proposal content. It accepts only the 900/1200-second hold alternatives and the reminder's exact 900-second dependency/assumption with its expected acceptance. Full considered sets, unchanged exclusivity and bounded complete impact are checked. The sole automatic partition selects hold 900 plus reminder and rejects hold 1200. No arbitrary expressions, general policy language, compromise synthesis or model reasoning is introduced. See the [2026-10-08 separation](PROFILE_SEPARATION.md).

A trusted constructor assignment and fresh baseline selector activate the dedicated fixture executor. It may endorse/seal only its covered selection: no behavioral authoring, evidence import, policy installation, scope/guardian/Release approval or redelegation. Shared checks cover direct `approve`/`resolve`, responses, cache reuse and publication. Actor labels or a policy descriptor alone grant nothing.

The host/preparer first freezes `mediation-basis/1`. An ordinary assigned author publishes separate decision-only `selection/2` Layers. The second prepare freezes `decision-packet/1` with their exact targets, full source material, intended timing/exclusivity effects, recommendation or unresolved status, unknown costs, defer and remaining gates. A response requires packet ref/digest, case revision and exact option. Only an authorized `approve_selection` response can create endorsement; defer, request_context and planning_direction cannot. New desired behavior requires new owned authoring. No timer or timeout acceptance exists.

The fixture debit, response/use receipt, endorsement and correlated commit audit share the existing atomic project publication. Same-input retries and changed explanatory messages reuse the first exact endorsement. Concurrent requests, staged failure, lost response, restart and retry-cache eviction produce one use. A different target/case or missing/incompatible debit state fails; the key cannot replenish authority. Receipt exhaustion does not invalidate its same still-authorized target. Expiry/revocation are rechecked before cached success and commit.

Installed configuration includes the actual fixture-assignment digest and a durable generation. A trusted constructor change requires an explicit bootstrap call against the identical original baseline and the next generation; this appends immutable supporting control, without editing authority or intent. Restarting the older configuration is refused. Loading historical descriptors or inactive backups never activates assignments. In-process `suspendForTest` remains a test control; persistent withdrawal is demonstrated by explicit higher-generation fixture activation with the executor grant/assignment removed. No production IAM or account membership service is claimed.

For v0.2, every open project `interaction-report/2` conservatively carries into renamed candidates and later baselines. A new report invalidates pending packets/endorsements even when executable bytes are unchanged. Responsible human fixture selectors may issue exact evidence-bound correction/nonapplicability dispositions; executor and prose claims cannot dispose of a report. Dispositions bind complete considered input/partition/effective content and asset pins, and do not globally close the report for changed future candidates. v0.1 retains its original revision-local reporting behavior.

Analysis allows at most 20 considered Layers, 50 collision items, 100 impacted Blocks/open reports, three executable alternatives, 128 KiB packets and ten seconds cooperative work. Cases allow an initial revision and two explicitly superseding revisions. There is no automatic retry loop or new orchestrator. Policy match and intent eligibility do not establish grant availability or passing behavior; response/sealing/publication independently recheck them.

## Evidence boundaries

| Exercised case | Observed result |
| --- | --- |
| Exact policy and input ordering | One unique complete partition, one executor endorsement/use; normalized input ordering returns the same basis. |
| Author/reader/preparer, missing selector/assignment, spoofed origin, direct lower-level resolve | Refused without granting endorsement; executor's direct sealing requires its own policy-use approval. |
| Extra writes/criteria/descriptions/impact, unknown scenario/acceptance version, ambiguous policies | Automatic policy stays unresolved; unsupported human options remain nonexecutable. |
| Packet/digest/case/option, authority/config/access/report changes, expired/exhausted grant | Altered or stale attempts refused; missing ledger is not treated as fresh balance. |
| Defer, context and new planning direction | No selection approval; deferred packet needs explicit new revision. |
| Report before endorsement/after approval, clones and new baselines | Pending work blocks; old Release bytes remain unchanged. Exact disposition supports fresh human reanalysis and does not cover the 1200 alternative. |
| Actual retained asset-pin replacement | Executable booking bytes unchanged, candidate changes; old evidence and approvals refused. Fresh validation passes. |
| Node commit fault/concurrency/restart/cache eviction | At most one debit, recoverable committed receipt and exact endorsement; expiry at commit/cache blocks pending success. |
| Local Agents SDK | Asset-free human packet/response/Resolution, measured legacy profile 2, strict v0.2 scope/Release approval and Release pass; late report blocks cached response. Dedicated executor durability is measured on Node and shared-core checks, not claimed as a separate SDK policy-provisioning run. |
| Fixed guardian | Validated expiry amendment fails without its guardian and succeeds with the exact protected-item approval. |
| Deliberate v0.2 evolution | R1 reminder/expiry 840/900, R2 1140/1200 with actual Node profile 4 evidence and fresh separate approvals. R1 bytes unchanged; stale approvals refused. |

The captured replay has six mechanical checks plus four explicit fixture review attestations per selected/evolved candidate. Those attestations are not independent human consent or cryptographic evidence. The host can modify code or results; no claim of general app correctness, completeness of semantic discovery, production authentication, zero bugs, fresh-model comprehension or comparative productivity/RAG superiority is made.

## Commands and host onboarding

The built CLI exposes `mediation prepare --file F`, `mediation respond --file F` and `reports dispose --file F`; `resolve`, `compose`, `materialize`, `validate`, `approve` and `release` retain their roles. Send one JSON object on stdin with `--file -`, and the existing host-supplied project/session flags. Do not select an executor identity in response to an error. [Schemas](../schemas/) and [the fixture helpers](../tests/mediation-helpers.ts) show complete synthetic records; they are examples, not installed authority.

Prepare stage 1 accepts `target`, `case_id`, `case_revision`, `expires_at`, `goal`, complete `partitions` and `supersedes` (null initially). It returns the basis and unsigned decision payloads. The authorized author creates/publishes its own decision-only Layers. Prepare stage 2 accepts `basis_ref` and `decisions` containing `option_id`, `layer`, `proposal_index`, and returns the exact packet/digest. Respond accepts `packet_ref`, `packet_sha256`, `case_revision`, `action`, nullable `option_id` and plain-text `message`. Only approve_selection names an option. The response origin, actor, generation and use are server-derived.

Scope/guardian/Release approval/2 records use the candidate fingerprint and exact validation evidence digest, `binding: null`, correct baseline/authority and current `status.mediation_generation`. Resolution approval is minted through the exact response path. Node checker-bound profiles 3/4 and legacy profiles 1/2 retain distinct evidence formats; SDK checker-bound/binary storage remain unsupported. Fresh v0.2 bootstrap activates the configured fixture control; existing semantic snapshots are never relabeled or automatically migrated.

Hosted trust, generalized policies, media processing, SDK binary/checker parity and active migration remain deferred.
