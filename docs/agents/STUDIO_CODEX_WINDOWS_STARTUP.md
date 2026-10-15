# Windows native Codex qualification

The preview targets native **Codex 0.162.1**, upstream source `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`. Version/schema preflight, launch, confinement, proposal correctness and human acceptance are separate checks. See [setup contract](STUDIO_CODEX_S2_HANDOFF.md), [runner instructions](../../deploy/studio-agent-runner/README.md) and [self-hosting](../studio/SELF_HOSTING.md).

## Startup contract

Use a dedicated native executable and private runner directory. Preserve existing desktop installations and credentials. The runner owns a separate Codex home, stdio app-server, pairing journal and exclusive lease. Offline preflight checks executable identity and experimental named-permission schemas before consuming a pairing code. Every start rechecks the executable. Credentials remain in the dedicated home; Studio receives device-code instructions and masked status, never account tokens.

Every task selects a fresh named profile: root denied, only the exact intent snapshot readable, no writes, parent, extra roots or platform-default read grant; command networking disabled. The dedicated process explicitly selects Windows MXC. Native admission checks returned profile, roots, model and approval policy. Compatibility or OS version does not prove enforcement. Shell, web, MCP and unapproved tool items remain refused.

A credential-free synthetic qualification must show readable allowed markers, refused unrelated reads/writes and child networking, and process-tree closure. Failure to start is not demonstrated denial. Preserve failure and reconcile it; do not add broad roots, switch sandbox backend or weaken custody. Native tools and app-server authentication/history have different access requirements.

## Bounded corrections

Custody traversal checks up to 8,192 entries at depth 16 in batches of at most 64 paths, retaining every identity/owner/DACL/link/race check, timeout and output limit. Large-tree tests reject unsafe late entries, truncated responses and excessive depth. This is bounded capacity, not a permission relaxation.

Native structured output encodes arbitrary JSON values, then completion and original-ID recovery decode through the ordinary proposal validator. Generation creates no draft. Human **Save as draft** uses owned authoring and records separate provenance.

Native deltas are batched into bounded progress chunks with final flush, preserving the event allowance. Stop tracks exact terminal identity, skips interrupts after terminal completion and accepts an interrupt/completion race only for that same turn. Transport failures and unknown outcomes stay retained. The proxy needs the reviewed agent-route body/time bounds: ingress failure can prevent final delivery after successful native interruption.

## Verified scope

A real native proposal was explicitly saved as a private draft and read back. Bounded recovery read an original retained thread/turn and delivered output without new inference. A separate fresh Stop observed native interrupt success, interrupted completion, cancelled output, successful delivery, matching local/Studio journals and restored browser controls.

That Stop used instrumented compiled modules with bounded admission and metadata-only tracing. ZIP contents/source identity were checked separately. This does not claim another uninstrumented packaged acceptance run or general Windows compatibility. Earlier normal completion before a late Stop remains normal completion; failures and spent allowances were retained. No publication or Release acceptance follows.

Private machines, paths, task/native identifiers, process IDs, screenshots and deployment receipts are omitted. Originals remain in private development history. Requalify each installation's executable, policies, HTTPS ingress, account and resource bounds.
