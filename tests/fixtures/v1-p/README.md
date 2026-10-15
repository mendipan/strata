# V1-P synthetic legacy history fixtures

`legacy-sha1.json` and `legacy-sha256.json` are deterministic structural record packs. They contain bootstrap and finalized successor associations for the existing v0.1 counter fixture. The native plan, acceptance and review use unbridged `/1`; current bridged `/2` schemas remain unchanged and have their existing G2 regression suites. The object format differs, while raw content and semantic digests always use SHA-256.

Every source/Git ref retains its full original record digest. `artifact_sha256` pins canonical immutable artifact bytes. Whole-file golden hashes are independently frozen in [the test](../../v1-p-native-git-contracts.test.ts). The packs include original semantic records, profile/checker/fixture/oracle pins, fixed fixture producer trust, code review, apply receipt, finalization and successor closure. Every Git OID, owner commit and passing outcome is synthetic. No app execution, authenticated provenance or native/runtime parity follows from these fixtures.

The fixture directory's own `.gitattributes` disables newline conversion for the golden packs, including Windows checkouts with `core.autocrlf=true`. It changes no repository-wide attributes.

[The generator](../../../scripts/v1-p/generate-fixtures.ts) uses the existing pure fixture contracts, writes only these packs and the standalone V1-P JSON schema, and never edits old schemas or dispatch. Build first, then run `node dist/scripts/v1-p/generate-fixtures.js` from the checkout root. Deliberate byte changes require review of the test's golden hashes.

`refusals.json` is a literal negative matrix of inspection-packet patches and expected refusal codes. The test also covers same-principal named authority substitution, digest-domain/alias substitution, duplicate evidence, legacy strict-schema refusals, rehashed missing native/semantic closure and existing inactive archive export/restore byte preservation. Archive tests create only disposable synthetic state under the OS temporary directory; they retain no active identity or requests.

See [the compatibility contract](../../../docs/V1_P_NATIVE_GIT_CONTRACT.md) for unsupported v0.3 requirements and review dependencies.
