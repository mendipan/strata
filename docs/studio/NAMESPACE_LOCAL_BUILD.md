# Namespace Studio Local Build

The optional Local Build mount executes on the Studio host. Browser paths,
commands, credentials and runner modules are never accepted as build inputs.
The destination is the configured host output slot; Worker, application run/serve,
and fresh semantic validation remain unavailable.

## Services and persistence

`runNamespaceStudio` accepts an optional final `NamespaceLocalBuildConfiguration`
argument. It mounts Build only on an explicitly configured v0.3 project with the
[namespace Profiles scope](NAMESPACE_PROFILES.md). Existing manifests and policy
/2 projects gain no grants or new write permissions.

The existing namespace broker remains the sole descriptor/index/artifact writer.
`createBuildRepository` is shared with the existing Local adapter. It retains
immutable attempt revisions, original request receipts and deterministic child
receipts for realization registration and measured finite checks. Namespace
transactions use the existing WorkspaceRuntime admission, budget, immutable
provider staging, current parent authority, provenance and guarded atomic index
publication. Output and finite checking run between these short transactions.
No competing Local registry or private profile database is opened.

An accepted attempt binds exact Release publication closure, profile revision,
reviewed adoption and contract, admitted materializer archive, actor/policy,
destination and protected output-root receipt. Prepare writes or executes
nothing. Start checks generation and policy CAS, rechecks those pins at privileged
steps and records actual phase transitions. Original-key replay reads retained
history and rechecks current repository access; it never dispatches a second run.

## Installation configuration hook

The host supplies `output: OutputSlot`: a stable slot ID/label, canonical absolute
protected root, complete excluded-root inventory and installation-owned protection
inspector. The mount requires exclusions covering namespace project/catalog/policy
storage, owner state/keys/credentials, served assets and agent storage. Include
other source/document/credential locations in the installation inventory too.
Use the existing native Unix or Windows output-protection inspector in production;
an always-true test inspector does not establish custody.

Providing this configuration explicitly selects the built-in finite Node runner
for `collection-host/1`. An optional `host` callback can report installation
readiness. It cannot select executable commands, install a toolchain or change
what the fixed runner executes. Current process OS, architecture, Node >=22 and
compiled adapter requirements are checked by the existing preflight.

The standard launcher accepts an optional strict `namespace_local_build` section
only in namespace mode. It constructs the native Linux protection inspector using
the running service identity and passes the existing trusted composition hook an
explicit repository allowlist. It creates no output directory or actor permission.
See [inactive operator preparation](NAMESPACE_BUILD_PREPARATION.md) for the schema,
exact tuple checks and separate installation gates. Windows launcher custody is
unsupported; the existing Windows composition adapter remains a separate API.
Activation must separately bind a reviewed host invocation/configuration to a
qualified output slot. The optional `startupRecovery(repository_id, issuer)` callback may
return an already configured live scoped recovery context; it creates no identity,
account or grant and has no public HTTP equivalent.

## Recovery and access

A cold host refuses fresh start keys while retained nonterminal attempts need
reconciliation. Inspection and original-key replay remain available. The private
startup recovery method requires `build.reconcile`, repository scope and exclusive
startup ownership. It reads the original registration/measurement child receipt,
checks its exact actor/action/key/input/result closure and appends an interrupted
attempt. It never exports again, reruns checks or pretends final-byte verification
finished. Missing child receipts remain unknown until explicit reconciliation
establishes their original outcome.

Provider-stage or canonical-writer uncertainty remains governed by existing
WorkspaceRuntime reconciliation; Build recovery cannot override that journal.
Verified artifact cache loss refuses startup without provider fallback. A private
Build receipt read does not repair custody or steal a stale writer lease.

Private transaction receipts retain their callback snapshot separately from the
latest original Build outcome. Exact step replay checks current operation and
repository authority before returning that snapshot. Review replay also checks
current Release-review authority; child replay checks the original visible build
and current start or recovery authority. A repeated acceptance reads the latest
attempt and cannot acquire output work again. Public original-outcome inspection
uses trusted receipt metadata, including nested callback results, to enforce the
current mounted repository scope.

Downloads recheck current identity/repository authority, exact realization pins,
output-root/allocation identity, complete inventory and bytes. Opaque file IDs bind
the build and name. Traversal, substitutions, extra/changed bytes and unavailable
or interrupted output refuse. No client path is forwarded to the runner.

## Qualification and activation handoff

Code integration can proceed independently of activation. Before activation,
review and explicitly approve the immutable code plus one exact host invocation,
output root/owner/protection/exclusions, finite runner/runtime, sealed namespace
manifest/policy /4 scopes, approved flattened Release/publication closure and
reviewed contract/adoption/profile pins. Preserve the existing namespace writer,
ingress and rollout baseline. Existing namespace create/import paths keep their
narrow policy /2 defaults; provisioning or migrating an activated writer lineage
is a separate operator procedure, not an automatic policy upgrade.

Synthetic tests exercise the real broker/WorkspaceRuntime/provider protocol with
an injected transport, real temporary file export and finite measurements. They
prove code behavior and durable synthetic history. They do not qualify production
Debian/Windows service custody, provider reliability, protected native output-root
ownership, stopped-host takeover or an attended live owner build. Qualification
still needs those separately approved host checks and browser/CLI rehearsal.
