"""Focused Linux root synthetic tests for the configuration transition.

Run with STRATA_NAMESPACE_HELPER pointing at the immutable hosting helper.
No real service/process, live data, network or provider is used here.
"""
import datetime, importlib.util, json, os, pathlib, tempfile, unittest, uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('namespace_mode', ROOT/'deploy/studio/namespace-mode.py')
mode = importlib.util.module_from_spec(spec); spec.loader.exec_module(mode)
t = mode.load_helper(os.environ['STRATA_NAMESPACE_HELPER'])


class Live:
    def __init__(self): self.running = True; self.events = []; self.fail_ready = False
    def uid(self):
        if not self.running: raise KeyError('synthetic DynamicUser NSS record absent while stopped')
        return 1001
    def stop(self): self.running = False; self.events.append('stop')
    def stopped(self): t.need(not self.running, 'NOT_STOPPED')
    def start(self): self.running = True; self.events.append('start')
    def run(self, *args): return 'ActiveState='+('active' if self.running else 'inactive')+'\nMainPID='+('123' if self.running else '0')
    def ready(self):
        if self.fail_ready: self.fail_ready = False; raise OSError('synthetic readiness failure')
        t.need(self.running, 'NOT_READY')


class Tests(unittest.TestCase):
    def setUp(self):
        self.directory = pathlib.Path(tempfile.mkdtemp(prefix='namespace-mode-', dir=os.environ.get('TMPDIR', '/run')))
        self.target = mode.Target(t, self.directory); self.live = Live(); self.uid = self.live.uid()
        for root in [self.target.etc, self.target.private, self.target.old.root]: root.mkdir(parents=True, mode=0o700)
        for root in self.directory.rglob('*'):
            if root.is_dir(): os.chmod(root, 0o700)
        os.chown(self.target.private, self.uid, self.uid)
        def directory(name):
            p = self.target.private/name; p.mkdir(mode=0o700); os.chown(p, self.uid, self.uid); return p
        self.secret_files = []
        for name in ['owner', 'security', 'credentials']:
            p = directory(name)/'synthetic-never-open.bin'; p.write_bytes(b'synthetic-private-sentinel'); os.chmod(p, 0o600); os.chown(p, self.uid, self.uid)
            self.secret_files.append(p)
        directory('connections'); directory('managed-read-budget'); directory('read-budget')
        host = {'format': 'strata-studio-host/1', 'public_origin': 'https://studio.example.test', 'trusted_proxy_addresses': ['127.0.0.1'], 'port': 4174,
            'source_management': {'policy_file': str(self.target.etc/'source-policy.json'), 'catalog_directory': str(self.target.private/'connections'), 'accounting_directory': str(self.target.private/'managed-read-budget')},
            'browser_owner': {'control_file': str(self.target.etc/'owner-control.json'), 'state_directory': str(self.target.private/'owner'), 'key_directory': str(self.target.private/'security'), 'credential_directory': str(self.target.private/'credentials')}}
        t.write_file(self.target.host, t.encoded(host), mode=0o644)
        release = self.target.old.root/'releases/synthetic-reviewed-release'
        release.mkdir(parents=True, mode=0o700); (self.target.old.root/'current').symlink_to(release)
        baseline = pathlib.Path(os.environ['STRATA_NAMESPACE_BASELINE'])
        manifest_raw = (baseline/'code-manifest.json').read_bytes(); manifest = t.strict_json(manifest_raw)
        for entry in manifest['files']:
            name = entry['path']
            file = release/name; file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            t.write_file(file, (baseline/name).read_bytes(), mode=0o644)
        t.write_file(self.target.etc/'release-manifest.json', manifest_raw, mode=0o644)
        service = self.target.old.base/'etc/systemd/system/strata-studio.service'; service.parent.mkdir(parents=True, mode=0o700)
        t.write_file(service, b'DynamicUser=yes\nMemoryMax=192M\nCPUQuota=50%\nTasksMax=32\n', mode=0o644)
        t.write_file(self.target.etc/'owner-control.json', t.encoded({'synthetic': 'sealed-owner-control'}), mode=0o644)
        t.write_file(self.target.etc/'source-policy.json', t.encoded({'valid_until': '2026-01-01T00:00:00Z'}), mode=0o644)
        t.write_file(self.target.private/'connections/genesis.json', t.encoded({'synthetic': 'original-genesis'}), owner=self.uid)
        t.write_file(self.target.private/'connections/state.json', t.encoded({'grants': []}), owner=self.uid)
        legacy = self.target.private/'read-budget/synthetic-read-ledger.json'
        t.write_file(legacy, t.encoded({'synthetic': 'retained-zero-ledger'}), owner=self.uid)
        lineage = str(uuid.uuid4()); transition = str(uuid.uuid4())
        ns = {'policy_file': str(self.target.etc/('namespace-policy-'+lineage+'.json')),
              'catalog_directory': str(self.target.private/('namespace-catalog-'+lineage)),
              'projects_directory': str(self.target.private/('namespace-projects-'+lineage))}
        class Op: pass
        self.op = Op(); self.op.digest = t.sha(b'synthetic-immutable-package')
        generation = t.sha(b'synthetic-generation')
        evidence = {'credential_id': 'artifacts-api-token', 'saved_credential_generation': generation, 'ciphertext_frame_valid': True,
                    'credential_decrypted': False, 'encryption_key_read': False, 'payload_emitted_or_copied': False}
        conformance = {'format': 'strata-studio-namespace-conformance/1', 'account': 'a'*32, 'namespace': 'synthetic',
            'repository': 'synthetic-conformance', 'saved_credential_generation': generation,
            'checks': {k: True for k in ['namespace_admission', 'read_edit', 'create', 'save', 'read_back', 'generation_match', 'automatic_expiry', 'owned_write_token_cleanup']},
            'automatic_token_max_lifetime_seconds': 86400, 'reserved_requests': 20, 'reserved_bytes': 100000, 'evidence_sha256': t.sha(b'synthetic-provider-evidence')}
        self.op.raw = {'saved-credential-version.json': t.encoded(evidence), 'provider-conformance.json': t.encoded(conformance)}
        self.op.conformance = conformance
        self.op.plan = {'format': 'strata-studio-namespace-mode-plan/1', 'transition_id': transition, 'source_commit': mode.SOURCE,
            'before_host_sha256': t.sha(self.target.host.read_bytes()), 'before_host': host, 'namespace': ns,
            'policy': {'lineage_id': lineage, 'account': 'a'*32, 'namespace': 'synthetic', 'automatic_token_max_lifetime_seconds': 86400},
            'legacy_ledger_path': str(legacy), 'legacy_ledger_sha256': t.sha(legacy.read_bytes()), 'saved_credential_generation': generation,
            'credential_metadata': t.owner_metadata(self.target.private/'credentials', self.uid)}
        self.proof = {'host': {k: v for k, v in host.items() if k != 'source_management'}, 'policy': {'synthetic': 'root-protected-policy'},
            'state': {'approved': False, 'connected': False, 'revoked': False, 'operations': []}, 'usage': {'reserved_requests': 0, 'reserved_bytes': 0},
            'prior_spending': {'requests': 12, 'bytes': 393020}, 'total_limits': {'requests': 10000, 'bytes': 1024**3}, 'policy_sha256': t.sha(b'policy')}
        self.proof['host']['namespace'] = ns
        self.validator = lambda *_: self.proof
        mode.layout(t, self.target, self.op)
        now = t.utc()
        t.write_file(self.target.approval, t.encoded({'format': 'strata-studio-namespace-mode-approval/1', 'action': 'install-unapproved-namespace-mode',
            'transition_id': transition, 'package_sha256': self.op.digest, 'approved_at': t.stamp(now), 'expires_at': t.stamp(now+datetime.timedelta(minutes=10)),
            'credential_generation_evidence_sha256': t.sha(self.op.raw['saved-credential-version.json']), 'provider_conformance_evidence_sha256': t.sha(self.op.raw['provider-conformance.json'])}))
        self.before, _ = mode.capture(self.target, self.op, self.uid); self.host = self.target.host.read_bytes()
        self.original_read = t.read_file
        def no_secrets(filename, *args, **kwargs):
            p = pathlib.Path(filename)
            if any(self.target.private/name in p.parents for name in ['owner', 'security', 'credentials']):
                raise AssertionError('operator attempted private credential/owner content read')
            return self.original_read(filename, *args, **kwargs)
        t.read_file = no_secrets

    def tearDown(self):
        t.read_file = self.original_read
        # Only this exact synthetic root, no live paths or cross-shell operations.
        import shutil
        assert self.directory.parent == pathlib.Path(os.environ.get('TMPDIR', '/run')) and self.directory.name.startswith('namespace-mode-')
        shutil.rmtree(self.directory)

    def unchanged(self):
        self.assertEqual(mode.capture(self.target, self.op, self.uid)[0], self.before)
        self.assertTrue(all(p.read_bytes() == b'synthetic-private-sentinel' for p in self.secret_files))

    def test_preflight_is_read_only_and_no_provider_or_secret_access(self):
        mode.preflight(self.target, self.op, self.live, self.validator)
        self.unchanged(); self.assertEqual(self.target.host.read_bytes(), self.host); self.assertEqual(self.live.events, [])
        self.assertFalse(self.target.intent.exists())

    def test_apply_rollback_retains_new_spend_tombstone_and_writer_history(self):
        mode.apply(self.target, self.op, self.live, self.validator); self.unchanged()
        self.assertEqual(t.strict_json(self.target.host.read_bytes()), self.proof['host'])
        ns = self.op.plan['namespace']; catalog = pathlib.Path(ns['catalog_directory']); projects = pathlib.Path(ns['projects_directory'])
        t.write_file(catalog/'usage.json', t.encoded({'reserved_requests': 7, 'reserved_bytes': 9000}), owner=self.uid)
        t.write_file(catalog/'revoked.json', t.encoded({'synthetic': 'permanent-tombstone'}), owner=self.uid)
        t.write_file(projects/'writer-history.json', t.encoded({'synthetic': 'canonical-private-history'}), owner=self.uid)
        retained = {str(p): p.read_bytes() for root in [catalog, projects] for p in root.iterdir()}
        mode.rollback(self.target, self.op, self.live); mode.rollback(self.target, self.op, self.live)
        self.unchanged(); self.assertEqual(self.target.host.read_bytes(), self.host)
        self.assertEqual(retained, {str(p): p.read_bytes() for root in [catalog, projects] for p in root.iterdir()})
        with self.assertRaises(t.Refused): mode.apply(self.target, self.op, self.live, self.validator)
        lineage = str(uuid.uuid4()); self.op.plan['transition_id'] = str(uuid.uuid4()); self.op.plan['policy']['lineage_id'] = lineage
        self.op.plan['namespace'] = {'policy_file': str(self.target.etc/('namespace-policy-'+lineage+'.json')),
            'catalog_directory': str(self.target.private/('namespace-catalog-'+lineage)), 'projects_directory': str(self.target.private/('namespace-projects-'+lineage))}
        with self.assertRaises(t.Refused) as error: mode.preflight(self.target, self.op, self.live, self.validator)
        self.assertEqual(error.exception.code, 'NAMESPACE_LINEAGE_ALREADY_RETAINED')

    def test_failures_at_each_publication_boundary_restore_only_configuration(self):
        stages = ['service-stopped', 'catalog_directory', 'projects_directory', 'namespace.json-written', 'namespace.json-durable',
                  'usage.json-durable', 'namespace-policy-durable', 'namespace-host-renamed', 'namespace-host-durable', 'service-started', 'service-ready', 'result-durable']
        # Each subcase owns an entirely separate installation.
        for stage in stages:
            with self.subTest(stage=stage):
                nested = Tests('test_preflight_is_read_only_and_no_provider_or_secret_access'); nested.setUp()
                def fail(actual):
                    if actual == stage: raise OSError('synthetic interruption')
                try:
                    with self.assertRaises(OSError): mode.apply(nested.target, nested.op, nested.live, nested.validator, fail)
                    nested.unchanged(); self.assertEqual(nested.target.host.read_bytes(), nested.host)
                    self.assertTrue(nested.live.running)
                finally: nested.tearDown()

    def test_os_exit_requires_exact_dead_operator_lease_and_retains_partial_namespace(self):
        # Real process exit bypasses finally, unlike an exception injection.
        pid = os.fork()
        if pid == 0:
            def crash(stage):
                if stage == 'namespace-host-durable': os._exit(77)
            mode.apply(self.target, self.op, self.live, self.validator, crash); os._exit(78)
        _, status = os.waitpid(pid, 0); self.assertEqual(os.waitstatus_to_exitcode(status), 77)
        self.assertTrue(self.target.lock.exists())
        with self.assertRaises(t.Refused): mode.rollback(self.target, self.op, self.live, '0'*64)
        sha = t.sha(self.target.lock.read_bytes())
        mode.rollback(self.target, self.op, self.live, sha); self.unchanged()
        self.assertEqual(self.target.host.read_bytes(), self.host)
        self.assertTrue(pathlib.Path(self.op.plan['namespace']['catalog_directory']).exists())

    def test_changed_host_custody_symlinks_and_live_operator_refuse(self):
        self.target.host.write_bytes(b'changed')
        with self.assertRaises(t.Refused): mode.preflight(self.target, self.op, self.live, self.validator)
        t.write_file(self.target.host, self.host, mode=0o644)
        mode.apply(self.target, self.op, self.live, self.validator)
        t.write_file(self.target.lock, t.encoded({'transition_id': self.op.plan['transition_id'], 'package_sha256': self.op.digest, 'process': t.process_identity()}), exclusive=True)
        sha = t.sha(self.target.lock.read_bytes())
        with self.assertRaises(t.Refused): mode.rollback(self.target, self.op, self.live, sha)
        self.target.lock.unlink()
        policy = pathlib.Path(self.op.plan['namespace']['policy_file']); policy.unlink(); policy.symlink_to(self.target.host)
        with self.assertRaises(t.Refused): mode.preflight(self.target, self.op, self.live, self.validator)

    def test_readiness_failure_rolls_back_without_reset_or_secret_access(self):
        self.live.fail_ready = True
        with self.assertRaises(OSError): mode.apply(self.target, self.op, self.live, self.validator)
        self.unchanged(); self.assertEqual(self.target.host.read_bytes(), self.host); self.assertTrue(self.live.running)

    def test_immutable_package_checks_generation_conformance_and_tamper(self):
        package = self.directory/'package'; package.mkdir(mode=0o700)
        raw = {**self.op.raw, 'plan.json': t.encoded(self.op.plan), 'namespace-mode.py': (ROOT/'deploy/studio/namespace-mode.py').read_bytes(),
               'validate-namespace-mode.mjs': b'// synthetic validator placeholder; never executed by this package test\n'}
        for name, data in raw.items(): t.write_file(package/name, data, mode=0o644)
        manifest = t.encoded({'format': 'strata-studio-namespace-mode-package/1',
                    'files': [{'name': name, 'bytes': len(data), 'sha256': t.sha(data)} for name, data in sorted(raw.items())]})
        t.write_file(package/'manifest.json', manifest, mode=0o644)
        loaded = mode.Package(t, package, t.sha(manifest)); self.assertEqual(loaded.conformance['reserved_requests'], 20)
        t.write_file(package/'provider-conformance.json', b'changed', mode=0o644)
        with self.assertRaises(t.Refused): mode.Package(t, package, t.sha(manifest))

    def test_missing_approval_or_changed_credential_stat_refuses_before_stop(self):
        self.target.approval.unlink()
        with self.assertRaises(FileNotFoundError): mode.apply(self.target, self.op, self.live, self.validator)
        self.assertEqual(self.live.events, [])
        self.op.plan['credential_metadata'] = {}
        with self.assertRaises(t.Refused): mode.preflight(self.target, self.op, self.live, self.validator)
        self.assertEqual(self.live.events, [])

    def test_login_spend_revoke_restart_rollback_retains_mutable_owner_and_namespace_history(self):
        mode.apply(self.target, self.op, self.live, self.validator)
        # Optional receipt comes from the real OwnerAccess/namespace lifecycle
        # fixture; it contains only synthetic counter/state/usage/tombstone data.
        receipt_path = os.environ.get('STRATA_NAMESPACE_LOGIN_LIFECYCLE')
        receipt = json.loads(pathlib.Path(receipt_path).read_text()) if receipt_path else {
            'login_limit': {'format': 'strata-owner-login-limit/1', 'attempts': [{'id': 'synthetic-failed-login', 'time': 1}]},
            'namespace': {'approved': True, 'revoked': True, 'connected': False},
            'usage': {'reserved_requests': 7, 'reserved_bytes': 9000}, 'tombstone': {'synthetic': 'retained-revoke'}}
        login = self.target.private/'owner/login-limit.json'
        t.write_file(login, t.encoded(receipt['login_limit']), owner=self.uid)
        ns = self.op.plan['namespace']; catalog = pathlib.Path(ns['catalog_directory'])
        for name, value in [('namespace.json', receipt['namespace']), ('usage.json', receipt['usage']), ('revoked.json', receipt['tombstone'])]:
            t.write_file(catalog/name, t.encoded(value), owner=self.uid)
        retained = {str(p): p.read_bytes() for p in catalog.iterdir()}
        owner_before = t.owner_metadata(self.target.private/'owner', self.uid); login_before = login.read_bytes()
        self.live.stop(); self.live.start(); self.live.ready()
        mode.rollback(self.target, self.op, self.live)
        self.assertTrue(self.live.running); self.assertEqual(self.target.host.read_bytes(), self.host)
        self.assertEqual(t.owner_metadata(self.target.private/'owner', self.uid), owner_before)
        self.assertEqual(login.read_bytes(), login_before)
        self.assertEqual(retained, {str(p): p.read_bytes() for p in catalog.iterdir()})

    def test_rollback_refusal_before_stop_and_raced_refusal_resume_verified_service(self):
        mode.apply(self.target, self.op, self.live, self.validator)
        ledger = pathlib.Path(self.op.plan['legacy_ledger_path']); original = ledger.read_bytes()
        t.write_file(ledger, b'changed', owner=self.uid); events = list(self.live.events)
        with self.assertRaises(t.Refused): mode.rollback(self.target, self.op, self.live)
        self.assertTrue(self.live.running); self.assertEqual(self.live.events, events)
        t.write_file(ledger, original, owner=self.uid)
        def raced(stage):
            if stage == 'rollback-stopped': t.write_file(ledger, b'changed-after-stop', owner=self.uid)
        with self.assertRaises(t.Refused): mode.rollback(self.target, self.op, self.live, hook=raced)
        self.assertTrue(self.live.running); self.assertEqual(ledger.read_bytes(), b'changed-after-stop')
        self.assertEqual(t.strict_json(self.target.host.read_bytes()), self.proof['host'])


if __name__ == '__main__':
    if os.geteuid() != 0: raise SystemExit('Synthetic POSIX custody tests require root in an isolated unit.')
    unittest.main(verbosity=2)
