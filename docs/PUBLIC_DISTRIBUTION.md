# Public source distribution

A public developer-preview repository should begin from the reviewed sanitized file snapshot. Retain full development ancestry privately. Do not publish a clone, bundle, mirror, old branches/tags, or a worktree .git file: historical operational records and screenshots have not been cleared for distribution.

The local exporter reads only a clean committed tree and emits public-source.zip plus public-files.json with every path, byte count and SHA-256. It rejects state directories and unreviewed image/archive/executable files. It performs no remote, repository creation, history rewriting or publication action:

```sh
node scripts/package-public-source.mjs --output /absolute/new/public-snapshot
```

Review the exact inventory and archive contents, preserve LICENSE/NOTICE and upstream notices, and initialize any future public repository from those reviewed files with fresh history. The local candidate commit retains private ancestry for review; it must not be pushed as the public root. Public source links intentionally use the eventual product repository name.

Current source has no tracked PNG/JPEG/GIF/WebP captures. The six-byte protected.bin adoption fixture is deliberate synthetic test data; it is not a screenshot. The legacy namespace browser fixture is text with its original Windows encoding. Synthetic transcripts and refusal examples do not contain live account credentials. Pattern scans are supporting evidence, not proof that arbitrary future additions are safe.

Archival namespace migration/conformance templates have synthetic account/origin/credential-generation/ledger/source/helper/manifest pins. Exact predicates, custody checks, budgets, approval fences and refusal behavior remain. The private helper and real installation action packets are not distributed; these templates cannot migrate a real host until independently reviewed and repinned. They are not the new-install bootstrap path.

See [self-hosting](studio/SELF_HOSTING.md), [roadmap](ROADMAP.md), [code packaging](studio/CODE_RELEASE.md) and [third-party notices](../THIRD_PARTY_NOTICES.md). Complete integrated Profile → Build follows publication; a private draft or bounded native test grants no public Release approval.
