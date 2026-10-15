# Native Codex setup and integration contract

Target: native **Codex 0.162.1**, upstream source `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`. [Windows qualification](STUDIO_CODEX_WINDOWS_STARTUP.md) records current acceptance; [self-hosting](../studio/SELF_HOSTING.md) gives installation steps.

Run `node studio-agent-runner.js --check-codex --codex-bin ABSOLUTE_NATIVE_EXECUTABLE` before pairing. It probes version and generates experimental schemas in an isolated home, checking named permissions, runtime roots and active-profile readback in ThreadStartParams, TurnStartParams and ThreadStartResponse. All three bind the digest. Success reports `native_qualified: false`; compatibility is distinct from confinement.

Use a dedicated private home and exclusive lease. Existing pairing/pending state is refused before transport. A lost reply remains pending; deleting markers or rerunning pairing is not recovery. No service/autostart is installed. Native credentials stay in that home, separate from desktop Codex.

Each thread selects a fresh transient root-deny profile with only the exact snapshot readable: no writes, parent, platform grant or extra roots; command networking disabled. MXC has no fallback. Check returned effective profile, workspace, model and approval policy before admission. Qualify actual allowed/denied access and process closure with synthetic data before attended authentication.

The bounded paginated model catalog comes from the native account. Studio/runner refuse unavailable models and never substitute one. RPC packets bind the task digest. Early events are bounded until exact turn identity is known. User-message items may be input; only agent messages supply output. Unapproved tools fail completion/recovery.

The structured-output adapter decodes into canonical proposal validation. Before/After preview and human Save remain separate. Save uses ordinary draft creation plus provenance under current owner/project/context/generation fences. Lost output or Save replies require original-operation inspection; unattributable admissions remain unresolved. Stop interrupts the original turn and reports its actual outcome. Timeout is not proof of billing stop.

Retain the namespace StudioAgentHttp seam, disjoint protected agent state, selected-source save/inspectSave ports and session recovery fences. Include every compiled agent module, the worker and runner ZIP in the [fixed inventory](../../deploy/studio/release-files.json). Serve ZIP downloads only through the owner-authenticated route. Preserve the 64 KiB application agent budget and [nginx ingress bounds](../../deploy/studio/nginx.conf.example).

Artifacts namespace/token setup is independent of Codex sign-in. Namespace consent grants no native credentials. Older schema receipts require explicit reconciliation, not journal deletion or silent migration. Synthetic setup/native/hub/HTTP/namespace tests remain distinct from attended evidence. A real proposal Save, bounded recovery and fresh Stop were demonstrated; instrumented runtime and packaged identity were checked separately. Claude and independent installations require separate acceptance.
