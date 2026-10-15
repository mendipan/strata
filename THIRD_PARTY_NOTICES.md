# Third-party notices

Strata source is licensed under [Apache-2.0](LICENSE). [NOTICE](NOTICE) identifies the project. Dependencies retain their own copyrights and terms; the project license does not relicense them. Full applicable upstream bundled licenses/notices are preserved verbatim in [BUNDLED_LICENSES.txt](licenses/BUNDLED_LICENSES.txt), generated from actual host, owner, checker, Windows runner and Worker bundle inputs. [Bundle evidence](licenses/bundle-evidence.json) records exact versions and upstream license-file SHA-256 values. Keep these files when redistributing bundles.

## Direct source dependencies

The following declarations come from the pinned root package/lockfile. Build tools are not all bundled runtime components.

| Package | Version | Declared license |
| --- | --- | --- |
| agents | 0.26.0 | MIT |
| zod | 4.6.5 | MIT |
| @babel/parser | 8.0.6 | MIT |
| @cloudflare/workers-types | 5.20261003.1 | MIT OR Apache-2.0 |
| @types/node | 26.6.4 | MIT |
| cf | 1.0.0-beta.12 | MIT OR Apache-2.0 |
| esbuild | 0.28.2 | MIT |
| tsx | 4.23.15 | MIT |
| typescript | 7.0.2 | Apache-2.0 |
| wrangler | 4.147.0 | MIT OR Apache-2.0 |

The previously omitted direct **@babel/parser 8.0.6** declares MIT. Its exact package LICENSE bytes are retained in [babel-parser-8.0.6-LICENSE](licenses/babel-parser-8.0.6-LICENSE), with its digest in bundle-evidence.json. This is direct dependency evidence, not an assumption from Babel branding.

## Windows runner and optional Claude dependencies

The ZIP bundles the Strata runner and **Zod 4.6.5 (MIT)**. It includes project notices, full bundled upstream notices, the exact SDK manifest/lock and a per-file manifest. Native Codex executables/authentication are supplied separately and are not included.

Choosing Claude runs the attended installer against the separate exact lockfile. The ZIP contains no Claude SDK or platform executable. **@anthropic-ai/claude-agent-sdk 0.3.296** declares `SEE LICENSE IN README.md`; its package also supplies [LICENSE.md](licenses/claude-agent-sdk-0.3.296-LICENSE.md): all rights reserved by Anthropic, subject to the linked legal agreements. The platform packages declare `SEE LICENSE IN LICENSE.md`. These are separate terms, not MIT or Apache-2.0. The package README points to [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) and [Privacy Policy](https://www.anthropic.com/legal/privacy); its LICENSE points to [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance). Preserve the actual downloaded SDK/platform license files if redistributing those components separately.

[The complete runner dependency inventory](licenses/runner-dependencies.json) lists every exact package location/version/license in deploy/studio-agent-runner/package-lock.json, including optional platform packages and peer/transitive dependencies. It includes MIT, ISC, BSD-2-Clause, BSD-3-Clause and Unlicense declarations in addition to the Anthropic terms. In particular @anthropic-ai/sdk is a distinct MIT package; it does not determine the Agent SDK's license. Installer-time Zod is **4.6.7**, distinct from the bundled **4.6.5**. The inventory is not a replacement for upstream license/NOTICE files or a blanket redistribution grant.

## Source and distribution boundary

Public source contains reusable contracts and synthetic examples. Private operational receipts, credentials, native homes and historical screenshots are excluded. Full private Git ancestry is not a public distribution artifact. Cloudflare, OpenAI/Codex, Anthropic/Claude and other product names identify integrations; no trademark license or endorsement is claimed. Links or proposals about external applications do not establish rights to redistribute their assets.
