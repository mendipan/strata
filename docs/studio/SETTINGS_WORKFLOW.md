# Studio Settings workflow

Open Settings to see the selected repository, masked token status and the next action. The page opens before metadata completes. Repository, credential and optional agent status load independently, each with a five-second deadline and an explicit retry. Loading Settings performs no provider read, discovery probe or credential mutation.

For persistent namespace access, use the [self-service browser setup](SELF_SERVICE_SETUP.md): save a Cloudflare API token, explicitly consent to the displayed scope, test namespace read and choose a repository. The catalog workflow below retains its existing preapproved-source boundaries.

## Connect a repository

1. Sign in using the existing Studio owner account.
2. If the token says **Saved on server**, keep it. Token replacement is under **Manage saved token** and requires explicit confirmation. If no token is saved, use **Save API token**.
3. Select an existing approved repository connection. When there is none, **Add an approved repository** lists only host-approved profiles and finite unused grants. Creating a connection leaves it disconnected.
4. Choose **Connect repository**. This dispatches the existing bounded verification operation against the selected grant and retained accounting. A previous successful Test read leaves connection intent unchanged.
5. After the server verifies the current runtime, choose **Open project** to inspect its published records. Opening the project reads that verified view without a new provider dispatch.

**Connection details and tools** contains exact project/model/repository scope, immutable snapshot reference, UTC expiry, accounting availability, Test read, Reconnect, Disconnect, Renew and Remove. The primary card shows read-only access and a readable expiry. Expired access is distinguished from a missing token. Renew remains an explicit action using another already approved grant; no new ticket, quota, authority or renewal is created by the page.

## Feedback and recovery

- Repeated primary clicks dispatch one action. Destructive connection/token confirmations support Escape, Cancel and focus restoration; navigation cancels them and clears secret drafts.
- Fresh-password confirmation supplies authentication only. The original denied action is not replayed; the user chooses an action again. If subsequent metadata cannot load, the source becomes unverified until an explicit refresh succeeds.
- Failed or timed-out metadata does not retain a current connected presentation. Retry refreshes metadata only. A token save/remove also invalidates the cached connected presentation until the server is checked again.
- A repository reply measured before a token change is discarded. Retry stale metadata explicitly; if a connection action was already dispatched, inspect its saved outcome without replaying it.
- Cancel waiting stops the browser wait. Dispatched work may have continued. Existing bounded owner/catalog-scoped UUID reconciliation remains available after navigation or reload; exact replay requires explicit inspection and the original payload. There is no automatic retry.
- Unavailable initial sign-in status produces a visible **Retry Studio** screen. Refused owner sign-in restores the form and clears the password; an authenticated status response can confirm a lost sign-in response.

Token status, tests and technical metadata do not reveal the stored provider value. Secret controls clear on dispatch, cancellation and navigation. Existing HttpOnly cookie, CSRF, exact Origin, stale revision, owner/policy generation and immutable reference checks remain server requirements. This UI change adds no API, CLI operation or storage format.

## Optional agents

**Agent service (optional)** is collapsed initially. It uses the existing configured discovery contract and presents its exact missing gates and reconciliation actions. Its status cannot block repository Settings. Neither loading nor expanding the panel starts discovery. Chat, inference and engine authoring are not inferred from a configured discovery connection.

## Verification

`tests/studio-settings-loading-browser.mjs` runs real Edge with disposable synthetic owner/token/catalog state and intercepted loopback HTTPS. It checks saved-tested-disconnected → explicit Connect → Open, repeated clicks, independent metadata timeouts, refused refresh, interrupted navigation, session retry, invalid sign-in, confirmation cancellation, fresh-password recovery, expiry, token removal and honest optional-agent availability. Existing owner setup, shared-reader credentials, legacy preview, managed reconciliation and agent recovery browser suites retain their original authority/persistence assertions under the new disclosure layout.

Desktop, 320px mobile and 720px zoom-equivalent viewports are checked. Native host/owner/credential/source/agent regressions protect the unchanged engine boundaries. Synthetic HTTPS interception is not a live owner action or deployment test. Operational receipts and screenshots remain outside product Git; publication/deployment requires the independently reviewed immutable candidate and current host-state preservation.
