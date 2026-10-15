# Studio browser connection setup

Settings reuses the encrypted server-side Artifacts API token and existing owner login. Namespace consent persists until revoked; normal browser and author sessions still expire.

## Browser flow

1. Sign in and open Settings. Save an Artifacts API token if none is saved.
2. Review the account and namespace, check **Allow access to this namespace until I revoke it**, and choose **Connect**. This records consent and lists repositories. Returning owners can use **Connect with saved token** without approving again.
3. Open **Choose repository** in Settings or the top bar. Search, refresh and pagination remain inside the approved namespace.
4. Choose **Open** beside an existing repository, review the import consent and choose **Import and open**. A retained index opens directly; other repositories accept a Strata project index JSON through the browser. Imported records retain their identity, content, author and publication state. New drafts use a fresh Studio author. Projects already registered open directly. **New Strata repository** remains available.
5. **Disconnect** pauses access without erasing consent. **Manage access > Revoke access** permanently revokes authorization; projects, saved token and spending remain.

Known failed reads and lost responses are inspected locally for direct explicit retry. Provider actions are never automatically replayed. Uncertain creations remain retained.

## Cloudflare permissions

Verified from official documentation on 2026-10-11:

- Account > Artifacts > Read: REST discovery and reads.
- Artifacts > Edit: creation, draft writes and repository Git-token issuance/cleanup. Edit includes read/list. Read plus Edit is sufficient.
- Limit Account Resources to the one intended account. This flow requires no Workers Scripts, DNS, R2, Account Settings or API-token administration permission.
- Cloudflare API tokens are account scoped; Studio enforces its namespace. Repository Git tokens cannot authenticate REST calls.

Sources: [Artifacts authentication](https://developers.cloudflare.com/artifacts/guides/authentication/), [token permissions/resources](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/), [REST API](https://developers.cloudflare.com/artifacts/api/rest-api/).

## Deployment and limits

A trusted operator provisions a new namespace lineage with explicit budgets and no initial browser consent. Existing installations need a reviewed migration retaining identity, credentials, repositories, catalogs and every accounting lineage. Never reset a ledger or restart failed conformance for fresh allowance.

Root-protected account/namespace binding, fixed provider origin, encryption, CSRF, revocation, repository identity and accounting remain enforced. Startup performs no provider request. Follow [self-hosting](SELF_HOSTING.md) and the [migration contract](NAMESPACE_MODE_OPERATOR.md).

Existing projects require an exact index and immutable-record verification. Import retains original history with a fresh writer for new drafts; it cannot reconstruct absent indices, impersonate authors, grant independent review/Release authority or enable agents.

## Verification

Focused backend tests cover encrypted custody, owner/session security, consent, provider errors, spending, replay, creation, drafts, switching and restart. Browser checks use Edge with real owner/actor HTTP and broker, against a synthetic provider. They cover saving, Connect, errors, lost responses, creation, drafts, switching, restart and mobile layout. They do not establish the owner's real token permissions or live Cloudflare write behavior.
