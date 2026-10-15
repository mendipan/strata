"""Focused root synthetic checks of the executable approval/package wrapper."""
import hashlib, importlib.util, json, os, pathlib, subprocess, tempfile, unittest, uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('conformance_wrapper', ROOT/'deploy/studio/namespace-conformance.py')
w = importlib.util.module_from_spec(spec); spec.loader.exec_module(w)
spec = importlib.util.spec_from_file_location('mode_primitives', ROOT/'deploy/studio/namespace-mode.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
t = m.load_helper(os.environ['STRATA_NAMESPACE_HELPER'])


class Tests(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp(prefix='conformance-wrapper-', dir=os.environ['TMPDIR']))

    def tearDown(self):
        import shutil
        assert self.root.parent == pathlib.Path(os.environ['TMPDIR']) and self.root.name.startswith('conformance-wrapper-')
        shutil.rmtree(self.root)

    def test_manifest_and_dependency_authenticated_before_import(self):
        code = self.root/'namespace-mode.py'; t.write_file(code, b"raise RuntimeError('unreviewed dependency executed')\n", mode=0o644)
        manifest = t.encoded({'files': [{'name': 'namespace-mode.py', 'bytes': code.stat().st_size, 'sha256': '0'*64}]})
        t.write_file(self.root/'manifest.json', manifest, mode=0o644)
        with self.assertRaisesRegex(RuntimeError, 'Dependency changed'): w.dependency(self.root, t.sha(manifest))
        with self.assertRaisesRegex(RuntimeError, 'Manifest changed'): w.dependency(self.root, '0'*64)

    def test_short_approval_binds_exact_packet_package_and_token_contract(self):
        import datetime
        run = str(uuid.uuid4()); start = t.utc(); filename = self.root/'approval.json'
        a = {'format': 'strata-studio-namespace-conformance-approval/1', 'action': 'named-create-save-read-back', 'approval_id': str(uuid.uuid4()),
             'run_id': run, 'packet_sha256': t.sha(b'packet'), 'package_sha256': t.sha(b'package'), 'approved_at': t.stamp(start),
             'expires_at': t.stamp(start+datetime.timedelta(minutes=10)), 'allow_saved_credential_use': True, 'retain_test_repository': True,
             'automatic_token_handling': 'discard-secret-no-revocation-claim'}
        t.write_file(filename, t.encoded(a), mode=0o644); self.assertEqual(w.approve(t, filename, a['packet_sha256'], a['package_sha256'], run), t.sha(filename.read_bytes()))
        with self.assertRaises(t.Refused): w.approve(t, filename, '0'*64, a['package_sha256'], run)
        a['expires_at'] = t.stamp(start+datetime.timedelta(minutes=16)); t.write_file(filename, t.encoded(a), mode=0o644)
        with self.assertRaises(t.Refused): w.approve(t, filename, a['packet_sha256'], a['package_sha256'], run)

    def test_root_authoritative_approval_nonroot_launch_expiry_tamper_and_removal(self):
        import datetime
        os.chmod(pathlib.Path(os.environ['TMPDIR']), 0o755); os.chmod(self.root, 0o755)
        filename = self.root/'approval.json'; run = str(uuid.uuid4()); start = t.utc()
        a = {'format': 'strata-studio-namespace-conformance-approval/1', 'action': 'named-create-save-read-back', 'approval_id': str(uuid.uuid4()),
            'run_id': run, 'packet_sha256': t.sha(b'synthetic-packet'), 'package_sha256': t.sha(b'synthetic-package'), 'approved_at': t.stamp(start),
            'expires_at': t.stamp(start+datetime.timedelta(minutes=10)), 'allow_saved_credential_use': True, 'retain_test_repository': True,
            'automatic_token_handling': 'discard-secret-no-revocation-claim'}
        raw = t.encoded(a)
        # Original0600 contract must be refused by the root wrapper, rather than
        # sealing intent and launching a child that cannot read the authority.
        t.write_file(filename, raw, mode=0o600)
        with self.assertRaises(t.Refused): w.approve(t, filename, a['packet_sha256'], a['package_sha256'], run)
        t.write_file(filename, raw, mode=0o644)
        approval_sha = w.approve(t, filename, a['packet_sha256'], a['package_sha256'], run)
        binding = {'run_id': run, 'packet_sha256': a['packet_sha256'], 'package_sha256': a['package_sha256'], 'approval_sha256': approval_sha}
        child = pathlib.Path(os.environ['STRATA_APPROVAL_CHILD']); node = os.environ.get('STRATA_TEST_NODE', '/opt/strata-studio/node/bin/node')
        command = ['/usr/bin/setpriv', '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs',
                   '--reuid=1001', '--regid=1001', '--clear-groups', node, str(child), str(filename), json.dumps(binding)]
        def launch(now):
            r = subprocess.run([*command, str(int(now.timestamp()*1000))], capture_output=True, text=True, timeout=15)
            self.assertEqual(r.stderr, ''); result = json.loads(r.stdout)
            self.assertEqual(result['uid'], 1001); self.assertTrue(result['capabilities_empty'])
            self.assertEqual(result['provider_calls'], 0); self.assertEqual(result['credential_calls'], 0)
            return r.returncode, result['status']
        self.assertEqual(launch(start), (0, 'approval-admitted'))
        self.assertEqual(launch(start+datetime.timedelta(minutes=11)), (4, 'approval-refused'))
        # Extending a still-root-owned file cannot extend the exact launch hash.
        a['expires_at'] = t.stamp(start+datetime.timedelta(minutes=14)); t.write_file(filename, t.encoded(a), mode=0o644)
        self.assertEqual(launch(start), (4, 'approval-refused'))
        t.write_file(filename, raw, mode=0o644); os.chown(filename, 1001, 1001)
        self.assertEqual(launch(start), (4, 'approval-refused'))
        os.chown(filename, 0, 0); os.chmod(filename, 0o666)
        self.assertEqual(launch(start), (4, 'approval-refused'))
        os.chmod(filename, 0o644); filename.unlink()
        self.assertEqual(launch(start), (4, 'approval-refused'))

    def test_actual_bundle_pure_packet_and_initial_state_do_not_touch_credentials(self):
        namespace_id = str(uuid.uuid4()); run = str(uuid.uuid4()); installation = str(uuid.uuid4()); owner = str(uuid.uuid4())
        start = t.utc(); end = start+__import__('datetime').timedelta(minutes=20)
        host = {'format': 'strata-studio-host/1', 'public_origin': 'https://studio.example.test', 'trusted_proxy_addresses': ['127.0.0.1'], 'port': 4174,
            'browser_owner': {'control_file': '/etc/strata-studio/owner-control.json', 'state_directory': '/var/lib/private/strata-studio/owner',
                'key_directory': '/var/lib/private/strata-studio/security', 'credential_directory': '/var/lib/private/strata-studio/credentials'},
            'source_management': {'policy_file': '/etc/strata-studio/source-policy.json', 'catalog_directory': '/var/lib/private/strata-studio/connections',
                'accounting_directory': '/var/lib/private/strata-studio/managed-read-budget'}}
        control = {'format': 'strata-studio-bootstrap-control/1', 'installation_id': installation, 'enrollment_epoch': str(uuid.uuid4()),
            'control_generation': 1, 'origin': host['public_origin'], 'purpose': 'enroll-owner', 'expected_owner_generation': 0,
            'issued_at': t.stamp(start), 'expires_at': t.stamp(end), 'state': 'closed',
            'owner_binding': {'installation_id': installation, 'owner_id': owner, 'initialization_id': str(uuid.uuid4()), 'key_id': str(uuid.uuid4()), 'initial_manifest_sha256': t.sha(b'synthetic manifest')}}
        bundle = pathlib.Path(os.environ['STRATA_CONFORMANCE_BUNDLE'])
        node = '/opt/strata-studio/node/bin/node'
        r = subprocess.run([node, str(bundle), '--prepare-stdin'], input=t.encoded({'host': host, 'control': control, 'username': 'synthetic.owner', 'run_id': run, 'lineage_id': namespace_id}), capture_output=True, timeout=15)
        self.assertEqual(r.returncode, 0, r.stderr.decode()); packet = t.strict_json(r.stdout)
        self.assertEqual(packet['policy']['account'], '0123456789abcdef0123456789abcdef'); self.assertEqual(packet['policy']['max_projects'], 1)
        self.assertEqual(packet['policy']['limits']['requests'], 160)
        r = subprocess.run([node, str(bundle), '--initial-stdin'], input=t.encoded(packet), capture_output=True, timeout=15)
        self.assertEqual(r.returncode, 0, r.stderr.decode()); initial = t.strict_json(r.stdout)
        self.assertFalse(initial['state']['approved']); self.assertEqual(initial['usage']['reserved_requests'], 0)
        self.assertEqual(packet['namespace']['policy_file'], '/etc/strata-studio/namespace-conformance-policy-'+namespace_id+'.json')


if __name__ == '__main__': unittest.main(verbosity=2)
