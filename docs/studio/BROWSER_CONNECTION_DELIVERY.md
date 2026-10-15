# Browser namespace connection contract

Settings reuses encrypted server-side Artifacts credentials and the current owner session. Connect records explicit account/namespace consent before discovery. Returning owners can reconnect with saved consent until revoked. Search, discovery and pagination stay inside the namespace.

Keep exact provider origin and namespace binding, CSRF, revocation, finite sessions/budgets, immutable repository identity and shared durable accounting. Startup performs no provider request. Pause preserves consent/spending; revoke preserves retained projects, token metadata and accounting history. Tokens confer no engine review or Release authority.

Known failed reads can be retried explicitly after inspection. Unknown creation/write results retain original operations for reconciliation; provider actions are never automatically replayed. Existing repositories require an exact Strata index; arbitrary Git files are not reconstructed.

Synthetic HTTP/browser fixtures cover token save, connect, errors, lost replies, creation, draft Save, selection, restart and mobile use. They establish no customer's live permissions. See [setup](SELF_SERVICE_SETUP.md), [self-hosting](SELF_HOSTING.md) and [import](BROWSER_IMPORT_DELIVERY.md).
