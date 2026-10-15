# PUBLIC TEMPLATE: synthetic installation pins; requires reviewed repinning and private helper.
"""Prepare a public packet or run ONE owner-approved named conformance job.

No live host.json/service/security edit, copied credential or general deployment.
Reuses the reviewed namespace operator's hosting primitives. prepare is read-only
apart from its non-secret packet; run retains every test lineage/partial outcome.
"""
import argparse, hashlib, importlib.util, json, os, pathlib, subprocess, sys, uuid

SOURCE = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
HELPER = '/opt/strata-studio/operator/reviewed/t1_transition.py'
FILES = {'namespace-conformance.py', 'namespace-mode.py', 'studio-namespace-conformance.mjs'}
ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'TZ': 'UTC'}


def dependency(package, expected_manifest_sha):
    path = package/'namespace-mode.py'
    info = path.lstat()
    if not path.is_file() or path.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022 or info.st_nlink != 1:
        raise RuntimeError('Protected reviewed package required')
    for parent in path.parents:
        s = parent.lstat()
        if not parent.is_dir() or parent.is_symlink() or s.st_uid != 0 or s.st_mode & 0o022:
            raise RuntimeError('Protected package parents required')
    # Authenticate the dependency BEFORE importing it. Root file permissions
    # alone are not evidence that this is the reviewed immutable package.
    mf = package/'manifest.json'; m = mf.lstat()
    if not mf.is_file() or mf.is_symlink() or m.st_uid != 0 or m.st_mode & 0o022 or m.st_nlink != 1 or m.st_size > 32768:
        raise RuntimeError('Protected bounded manifest required')
    raw = mf.read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected_manifest_sha: raise RuntimeError('Manifest changed')
    manifest = json.loads(raw)
    entries = [e for e in manifest.get('files', []) if e.get('name') == 'namespace-mode.py']
    if len(entries) != 1 or info.st_size > 128*1024: raise RuntimeError('Reviewed dependency required')
    data = path.read_bytes()
    if len(data) != entries[0].get('bytes') or hashlib.sha256(data).hexdigest() != entries[0].get('sha256'):
        raise RuntimeError('Dependency changed')
    spec = importlib.util.spec_from_file_location('namespace_mode_primitives', path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def package_check(t, package, sha):
    t.need({p.name for p in package.iterdir()} == FILES | {'manifest.json'}, 'PACKAGE_FILES')
    raw = t.read_file(package/'manifest.json', 32768); t.need(t.sha(raw) == sha, 'PACKAGE_CHANGED')
    m = t.strict_json(raw)
    t.need(set(m) == {'format', 'source_commit', 'files'} and m['format'] == 'strata-studio-namespace-conformance-package/1' and
           m['source_commit'] == SOURCE and type(m['files']) is list and len(m['files']) == 3, 'PACKAGE_FORMAT')
    seen = set()
    for e in m['files']:
        t.need(set(e) == {'name', 'bytes', 'sha256'} and e['name'] in FILES and e['name'] not in seen, 'PACKAGE_FILES')
        data = t.read_file(package/e['name'], 8*1024**2)
        t.need(len(data) == e['bytes'] and t.sha(data) == e['sha256'], 'PACKAGE_CHANGED'); seen.add(e['name'])
    t.need(seen == FILES and t.sha(t.read_file(pathlib.Path(__file__).resolve(), 128*1024)) ==
           next(e['sha256'] for e in m['files'] if e['name'] == 'namespace-conformance.py'), 'OPERATOR_CHANGED')


def approve(t, approval_file, packet_sha, package_sha, run_id):
    # This is an authoritative non-secret root control, reread by the nonroot
    # child. Root0644 permits reads without capabilities, never service writes.
    raw = t.read_file(approval_file, 4096, exact_mode=0o644); a = t.strict_json(raw)
    t.need(set(a) == {'format', 'action', 'approval_id', 'run_id', 'packet_sha256', 'package_sha256', 'approved_at', 'expires_at',
                     'allow_saved_credential_use', 'retain_test_repository', 'automatic_token_handling'}, 'OWNER_APPROVAL_REQUIRED')
    t.need(a['format'] == 'strata-studio-namespace-conformance-approval/1' and a['action'] == 'named-create-save-read-back' and
           a['run_id'] == run_id and a['packet_sha256'] == packet_sha and a['package_sha256'] == package_sha and
           str(uuid.UUID(a['approval_id'])) == a['approval_id'] and a['allow_saved_credential_use'] is True and
           a['retain_test_repository'] is True and a['automatic_token_handling'] == 'discard-secret-no-revocation-claim', 'OWNER_APPROVAL_BINDING')
    begin = t.when(a['approved_at']); end = t.when(a['expires_at'])
    t.need(begin <= t.utc() < end and 0 < (end-begin).total_seconds() <= 900, 'OWNER_APPROVAL_EXPIRED')
    return t.sha(raw)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('action', choices=['prepare', 'run'])
    p.add_argument('--package', required=True); p.add_argument('--package-sha256', required=True)
    p.add_argument('--username'); p.add_argument('--packet'); p.add_argument('--packet-sha256')
    args = p.parse_args()
    try:
        if os.geteuid() != 0 or sys.platform != 'linux': raise RuntimeError('Root packet/staging context required')
        package = pathlib.Path(args.package); mode = dependency(package, args.package_sha256); t = mode.load_helper(HELPER)
        package_check(t, package, args.package_sha256); target = mode.Target(t); node = t.node_snapshot(target.old)[0]
        baseline = t.read_file(target.etc/'release-manifest.json', 32768)
        t.need(t.sha(baseline) == mode.RELEASE_MANIFEST_SHA and (target.old.root/'current').is_symlink() and
               (target.old.root/'current').resolve() == target.old.root/'releases/synthetic-reviewed-release', 'DEPLOYED_BASELINE_CHANGED')
        intent_file = target.etc/'namespace-conformance-intent.json'
        if args.action == 'prepare':
            t.need(args.username and not intent_file.exists() and not intent_file.is_symlink(), 'CONFORMANCE_ALREADY_RETAINED')
            host = t.strict_json(t.read_file(target.host, 16384)); control = t.strict_json(t.read_file(target.etc/'owner-control.json', 4096))
            run_id = str(uuid.uuid4()); lineage_id = str(uuid.uuid4())
            r = subprocess.run([str(node), str(package/'studio-namespace-conformance.mjs'), '--prepare-stdin'],
                input=t.encoded({'host': host, 'control': control, 'username': args.username, 'run_id': run_id, 'lineage_id': lineage_id}),
                capture_output=True, env=ENV, timeout=15)
            t.need(r.returncode == 0 and len(r.stdout) <= 32768, 'PACKET_PREPARATION_REFUSED'); packet = t.strict_json(r.stdout)
            raw = t.encoded(packet); filename = target.etc/('namespace-conformance-'+run_id+'-packet.json')
            t.write_file(filename, raw, mode=0o644, exclusive=True)
            print(json.dumps({'status': 'public-packet-only', 'packet': str(filename), 'packet_sha256': t.sha(raw), 'run_id': run_id,
                              'approval': str(target.etc/('namespace-conformance-'+run_id+'-approval.json')), 'authority_configured': False})); return 0
        t.need(args.packet and args.packet_sha256, 'EXACT_PACKET_REQUIRED')
        packet_file = t.canonical_path(args.packet); raw = t.read_file(packet_file, 32768); t.need(t.sha(raw) == args.packet_sha256, 'PACKET_CHANGED')
        packet = t.strict_json(raw); run_id = str(uuid.UUID(packet['run_id'])); lineage = str(uuid.UUID(packet['policy']['lineage_id']))
        t.need(packet_file == target.etc/('namespace-conformance-'+run_id+'-packet.json'), 'PACKET_PATH')
        approval_file = target.etc/('namespace-conformance-'+run_id+'-approval.json')
        approval_sha = approve(t, approval_file, args.packet_sha256, args.package_sha256, run_id)
        uid = t.Live().uid(); t.need(target.private.lstat().st_uid == uid, 'SERVICE_UID_CHANGED')
        # Stage only the packet's NEW test lineage after the exact confirmation.
        # A consumed intent/new UUID cannot create another zero test allowance.
        expected = {'policy_file': str(target.etc/('namespace-conformance-policy-'+lineage+'.json')),
                    'catalog_directory': str(target.private/('namespace-conformance-catalog-'+lineage)),
                    'projects_directory': str(target.private/('namespace-conformance-projects-'+lineage))}
        t.need(packet['namespace'] == expected, 'CONFORMANCE_PATHS')
        intent = {'format': 'strata-studio-namespace-conformance-intent/1', 'run_id': run_id, 'lineage_id': lineage,
                  'packet_sha256': args.packet_sha256, 'package_sha256': args.package_sha256, 'service_uid': uid}
        if intent_file.exists() or intent_file.is_symlink():
            t.need(t.strict_json(t.read_file(intent_file, 8192, exact_mode=0o600)) == intent, 'CONFORMANCE_RECONCILIATION_REQUIRED')
        else:
            # Use the pure helper in the same reviewed bundle; no service startup
            # or credential access occurs during this bounded preparation call.
            r = subprocess.run([str(node), str(package/'studio-namespace-conformance.mjs'), '--initial-stdin'], input=raw,
                               capture_output=True, env=ENV, timeout=15)
            t.need(r.returncode == 0 and len(r.stdout) <= 32768, 'INITIAL_STATE_REFUSED'); initial = t.strict_json(r.stdout)
            for filename in map(pathlib.Path, expected.values()): t.need(not filename.exists() and not filename.is_symlink(), 'TEST_LINEAGE_EXISTS')
            t.write_file(intent_file, t.encoded(intent), exclusive=True)
            for key in ['catalog_directory', 'projects_directory']: t.create_dir(pathlib.Path(expected[key]), uid, lambda _: None, key)
            t.write_file(pathlib.Path(expected['catalog_directory'])/'namespace.json', t.encoded(initial['state']), owner=uid, exclusive=True)
            t.write_file(pathlib.Path(expected['catalog_directory'])/'usage.json', t.encoded(initial['usage']), owner=uid, exclusive=True)
            t.write_file(pathlib.Path(expected['policy_file']), t.encoded(packet['policy']), mode=0o644, exclusive=True)
        # Same already allocated DynamicUser/StateDirectory mount as Studio;
        # no changes to the existing unit. Password enters only the child's TTY.
        props = ['Type=oneshot', 'User=strata-studio', 'DynamicUser=yes', 'StateDirectory=strata-studio', 'StateDirectoryMode=0700',
                 'UMask=0077', 'ProtectSystem=strict', 'ProtectHome=yes', 'PrivateTmp=yes', 'PrivateDevices=yes', 'NoNewPrivileges=yes',
                 'CapabilityBoundingSet=', 'MemoryMax=192M', 'TasksMax=32', 'CPUQuota=50%', 'LimitNOFILE=256', 'TimeoutStartSec=900s']
        command = ['systemd-run', '--quiet', '--wait', '--pty', '--unit=strata-conformance-'+run_id,
                   *['--property='+v for v in props], str(node), '--max-old-space-size=128', str(package/'studio-namespace-conformance.mjs'),
                   '--packet', str(packet_file), '--packet-sha256', args.packet_sha256, '--approval', str(approval_file), '--package-sha256', args.package_sha256,
                   '--approval-sha256', approval_sha]
        r = subprocess.run(command, env=ENV)
        print(json.dumps({'status': 'conformance-completed' if r.returncode == 0 else 'conformance-stopped-retain-outcome',
                          'run_id': run_id, 'approval_sha256': approval_sha, 'retained_directory': expected['catalog_directory'], 'exit_code': r.returncode})); return r.returncode
    except Exception as error:
        print(json.dumps({'status': 'refused', 'code': getattr(error, 'code', 'CONFORMANCE_OPERATOR_FAILED'), 'credential_contents_copied': False})); return 1


if __name__ == '__main__': raise SystemExit(main())
