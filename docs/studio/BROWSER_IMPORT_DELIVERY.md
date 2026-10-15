# Existing repository import contract

Import uses a retained or browser-uploaded exact Strata index with explicit owner consent. It verifies repository identity and every immutable record/asset under the namespace budget and encrypted credential callback. Remote history is not rewritten.

Retain the supplied index intact. A fresh writer supports new owned drafts; historical records retain identity, author, content and publication state. Visibility does not confer private workflow access or permission to overwrite another author's draft. Preserve the imported model rather than silently upgrading it.

Selection, authentication, CSRF, namespace consent, credentials and accounting remain enforced. No selection is distinct from read-only access. Import cannot infer absent publication/private state from arbitrary Git objects, create independent review roles, approve Releases or enable agent execution.

Synthetic backend/browser checks exercise immutable reads, consent, drafts, restart, selection and mobile behavior. Each host must qualify custody, actual provider permissions, index identity and lost-response recovery. See [self-hosting](SELF_HOSTING.md).
