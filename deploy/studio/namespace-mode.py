# PUBLIC TEMPLATE: synthetic installation pins; requires reviewed repinning and private helper.
"""Namespace CONFIG transition only. No provider, credential or TLS recovery API.

Uses the pinned hosting operator's filesystem/service primitives; never invokes
its T1 apply/recovery paths. Retains both lineages on success AND rollback.
"""
import argparse, hashlib, importlib.util, json, os, pathlib, re, stat, subprocess, sys, uuid

HELPER_SHA = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
SOURCE = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
RELEASE_MANIFEST_SHA = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
FILES = {'namespace-mode.py', 'validate-namespace-mode.mjs', 'plan.json', 'saved-credential-version.json', 'provider-conformance.json'}


def load_helper(filename):
    # Only code bytes, never state or credentials. Same hosting dependency pin.
    filename = pathlib.Path(filename)
    s = filename.lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_uid != 0 or s.st_nlink != 1 or s.st_mode & 0o022 or s.st_size > 128*1024:
        raise RuntimeError('Unsafe hosting helper')
    for parent in filename.parents:
        s = parent.lstat()
        if not stat.S_ISDIR(s.st_mode) or parent.is_symlink() or s.st_uid != 0 or s.st_mode & 0o022:
            raise RuntimeError('Unsafe hosting helper parent')
    if hashlib.sha256(filename.read_bytes()).hexdigest() != HELPER_SHA:
        raise RuntimeError('Hosting helper differs')
    spec = importlib.util.spec_from_file_location('namespace_host_primitives', filename)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


class Target:
    def __init__(self, t, base='/'):
        self.t = t; self.old = t.Target(base)
        self.etc = self.old.etc; self.private = self.old.private; self.host = self.old.host
        self.lock = self.etc / '.namespace-mode.lock'


class Package:
    def __init__(self, t, directory, manifest_sha):
        self.root = t.canonical_path(directory)
        t.need({p.name for p in self.root.iterdir()} == FILES | {'manifest.json'}, 'PACKAGE_FILES')
        raw = t.read_file(self.root / 'manifest.json', 32768)
        t.need(t.sha(raw) == manifest_sha, 'PACKAGE_CHANGED'); self.digest = manifest_sha
        m = t.strict_json(raw)
        t.need(set(m) == {'format', 'files'} and m['format'] == 'strata-studio-namespace-mode-package/1' and
               type(m['files']) is list and len(m['files']) == len(FILES), 'PACKAGE_FORMAT')
        self.raw = {}
        for item in m['files']:
            t.need(set(item) == {'name', 'bytes', 'sha256'} and item['name'] in FILES and
                   item['name'] not in self.raw and type(item['bytes']) is int and 0 < item['bytes'] <= 8*1024**2, 'PACKAGE_FORMAT')
            data = t.read_file(self.root / item['name'], 8*1024**2)
            t.need(len(data) == item['bytes'] and t.sha(data) == item['sha256'], 'PACKAGE_CHANGED')
            self.raw[item['name']] = data
        t.need(set(self.raw) == FILES, 'PACKAGE_FORMAT')
        self.plan = t.strict_json(self.raw['plan.json']); p = self.plan
        t.need(set(p) == {'format', 'transition_id', 'source_commit', 'before_host_sha256', 'before_host',
                         'namespace', 'policy', 'legacy_ledger_path', 'legacy_ledger_sha256', 'saved_credential_generation', 'credential_metadata'}, 'PLAN_FORMAT')
        t.need(p['format'] == 'strata-studio-namespace-mode-plan/1' and p['source_commit'] == SOURCE and
               str(uuid.UUID(p['transition_id'])) == p['transition_id'], 'PLAN_FORMAT')
        t.need(type(p['saved_credential_generation']) is str and re.fullmatch('[a-f0-9]{64}', p['saved_credential_generation']) and
               p['saved_credential_generation'] != '0'*64, 'SAVED_CREDENTIAL_VERSION_REQUIRED')
        evidence = t.strict_json(self.raw['saved-credential-version.json'])
        t.need(evidence.get('credential_id') == 'artifacts-api-token' and evidence.get('saved_credential_generation') == p['saved_credential_generation'] and
               evidence.get('ciphertext_frame_valid') is True and evidence.get('credential_decrypted') is False and
               evidence.get('encryption_key_read') is False and evidence.get('payload_emitted_or_copied') is False, 'SAVED_CREDENTIAL_EVIDENCE')
        self.conformance = t.strict_json(self.raw['provider-conformance.json']); c = self.conformance
        t.need(set(c) == {'format', 'account', 'namespace', 'repository', 'saved_credential_generation', 'checks',
                         'automatic_token_max_lifetime_seconds', 'reserved_requests', 'reserved_bytes', 'evidence_sha256'} and
               c['format'] == 'strata-studio-namespace-conformance/1' and c['account'] == p['policy']['account'] and
               c['namespace'] == p['policy']['namespace'] and c['repository'] == 'synthetic-conformance' and
               c['saved_credential_generation'] == p['saved_credential_generation'], 'PROVIDER_CONFORMANCE_BINDING')
        checks = ['namespace_admission', 'read_edit', 'create', 'save', 'read_back', 'generation_match', 'automatic_expiry', 'owned_write_token_cleanup']
        t.need(set(c['checks']) == set(checks) and all(c['checks'][k] is True for k in checks), 'PROVIDER_CONFORMANCE_REQUIRED')
        t.need(type(c['reserved_requests']) is int and 1 <= c['reserved_requests'] <= 160 and
               type(c['reserved_bytes']) is int and 1 <= c['reserved_bytes'] <= 50*1024**2 and
               type(c['automatic_token_max_lifetime_seconds']) is int and
               60 <= c['automatic_token_max_lifetime_seconds'] <= p['policy']['automatic_token_max_lifetime_seconds'] <= 86400 and
               type(c['evidence_sha256']) is str and re.fullmatch('[a-f0-9]{64}', c['evidence_sha256']) and c['evidence_sha256'] != '0'*64, 'PROVIDER_CONFORMANCE_LIMITS')
        t.need(t.sha(self.raw['namespace-mode.py']) == t.sha(t.read_file(pathlib.Path(__file__).resolve(), 128*1024)), 'OPERATOR_CHANGED')


def layout(t, target, op):
    p = op.plan; ns = p['namespace']; h = p['before_host']
    t.need(set(ns) == {'policy_file', 'catalog_directory', 'projects_directory'}, 'NAMESPACE_PATHS')
    suffix = str(uuid.UUID(p['policy']['lineage_id']))
    t.need(ns == {'policy_file': str(target.etc / ('namespace-policy-' + suffix + '.json')),
                  'catalog_directory': str(target.private / ('namespace-catalog-' + suffix)),
                  'projects_directory': str(target.private / ('namespace-projects-' + suffix))}, 'NAMESPACE_PATHS')
    t.need(h.get('source_management') == {'policy_file': str(target.etc/'source-policy.json'),
                 'catalog_directory': str(target.private/'connections'),
                 'accounting_directory': str(target.private/'managed-read-budget')} and
           h.get('browser_owner') == {'control_file': str(target.etc/'owner-control.json'),
                 'state_directory': str(target.private/'owner'), 'key_directory': str(target.private/'security'),
                 'credential_directory': str(target.private/'credentials')}, 'HOST_PATHS')
    t.need({k: h.get(k) for k in ['format', 'public_origin', 'trusted_proxy_addresses', 'port']} == {
        'format': 'strata-studio-host/1', 'public_origin': 'https://studio.example.test',
        'trusted_proxy_addresses': ['127.0.0.1'], 'port': 4174}, 'HOST_BOUNDARY')
    legacy = t.canonical_path(p['legacy_ledger_path'])
    t.need(legacy.parent == target.private/'read-budget' and legacy.name == 'synthetic-read-ledger.json', 'LEGACY_PATH')
    target.intent = target.etc / ('namespace-mode-' + p['transition_id'] + '-intent.json')
    target.result = target.etc / ('namespace-mode-' + p['transition_id'] + '-result.json')
    target.approval = target.etc / ('namespace-mode-' + p['transition_id'] + '-approval.json')


def capture(target, op, uid):
    t = target.t; p = op.plan; hashes = {}; values = {}
    def read(name, limit=2*1024**2):
        private = target.private if target.private in name.parents else None
        raw = t.read_file(name, limit, private, uid if private else None, 0o600 if private else None)
        hashes[str(name)] = t.sha(raw); return t.strict_json(raw)
    release = target.old.root/'releases/synthetic-reviewed-release'
    pointer = target.old.root/'current'
    t.need(pointer.is_symlink() and pointer.resolve() == release, 'RELEASE_POINTER_CHANGED')
    manifest = read(target.etc/'release-manifest.json', 32768)
    t.need(hashes[str(target.etc/'release-manifest.json')] == RELEASE_MANIFEST_SHA, 'DEPLOYED_PACKAGE_CHANGED')
    t.need(manifest['source_commit'] == SOURCE and type(manifest['files']) is list and len(manifest['files']) == 28, 'DEPLOYED_SOURCE_CHANGED')
    names = set()
    for entry in manifest['files']:
        name = entry['path']
        t.need(type(name) is str and re.fullmatch(r'(package\.json|dist/scripts/studio-(host|owner-control)\.js|explorer/[a-z-]+\.(html|js|css|svg))', name)
               and name not in names, 'RELEASE_PATH')
        names.add(name); raw = t.read_file(release/name, 8*1024**2)
        t.need(len(raw) == entry['bytes'] and t.sha(raw) == entry['sha256'], 'RELEASE_CHANGED')
        hashes[str(release/name)] = t.sha(raw)
    # Match the already approved envelope, never rewrite a service/security file.
    service = target.old.base/'etc/systemd/system/strata-studio.service'
    raw_service = t.read_file(service, 16384)
    for line in [b'MemoryMax=192M', b'CPUQuota=50%', b'TasksMax=32', b'DynamicUser=yes']:
        t.need(line in raw_service.splitlines(), 'SERVICE_ENVELOPE_CHANGED')
    hashes[str(service)] = t.sha(raw_service)
    values['control'] = read(target.etc/'owner-control.json', 4096)
    # Positive non-secret paths only; never open keys, credentials, verifier,
    # original TLS registry/data, or writer recovery history.
    values['policy'] = read(target.etc/'source-policy.json', 256*1024)
    catalog = target.private/'connections'; accounting = target.private/'managed-read-budget'
    t.need({f.name for f in catalog.iterdir()} == {'genesis.json', 'state.json'}, 'PREDECESSOR_BUSY')
    values['genesis'] = read(catalog/'genesis.json'); values['state'] = read(catalog/'state.json')
    grants = values['state']['grants']; names = {g['grant_id'] for g in grants}
    t.need(len(names) == len(grants) and {f.name for f in accounting.iterdir()} == names, 'PREDECESSOR_ACCOUNTING')
    values['ledgers'] = []
    for name in sorted(names):
        t.need(str(uuid.UUID(name)) == name, 'PREDECESSOR_ACCOUNTING')
        folder = accounting/name
        t.need({f.name for f in folder.iterdir()} == {'grant.json', 'read-budget.json'}, 'PREDECESSOR_BUSY')
        values['ledgers'].append({'grant': read(folder/'grant.json', 32768), 'ledger': read(folder/'read-budget.json', 1024)})
    values['legacy_ledger'] = read(pathlib.Path(p['legacy_ledger_path']), 1024)
    t.need(hashes[p['legacy_ledger_path']] == p['legacy_ledger_sha256'], 'LEGACY_ACCOUNTING_CHANGED')
    metadata = {name: t.owner_metadata(target.private/name, uid) for name in ['owner', 'security', 'credentials']}
    t.need(metadata['credentials'] == p['credential_metadata'], 'SAVED_CREDENTIAL_CUSTODY_CHANGED')
    return {'hashes': hashes, 'metadata': metadata}, values


def validate(target, op, values):
    t = target.t
    payload = {'host': op.plan['before_host'], 'control': values['control'], 'namespace': op.plan['namespace'],
               'policy': op.plan['policy'], 'predecessor': {k: v for k, v in values.items() if k != 'control'},
               'conformance_spending': {'requests': op.conformance['reserved_requests'], 'bytes': op.conformance['reserved_bytes'], 'projects': 1}}
    # Import existing schemas/preparation helper through a reviewed bundle. No
    # provider port is constructed, and the validator receives no secret files.
    node = t.node_snapshot(target.old)[0]
    result = subprocess.run([str(node), '--max-old-space-size=128', str(op.root/'validate-namespace-mode.mjs'), '--validate-stdin'],
                            input=t.encoded(payload), capture_output=True, env=t.MINIMAL_ENV, timeout=20)
    t.need(result.returncode == 0 and len(result.stdout) <= 256*1024, 'SCHEMA_VALIDATION_FAILED')
    return t.strict_json(result.stdout)


def owner_approval(target, op):
    t = target.t; raw = t.read_file(target.approval, 4096, exact_mode=0o600); p = t.strict_json(raw)
    t.need(set(p) == {'format', 'action', 'transition_id', 'package_sha256', 'approved_at', 'expires_at',
                     'credential_generation_evidence_sha256', 'provider_conformance_evidence_sha256'}, 'OWNER_APPROVAL_REQUIRED')
    t.need(p['format'] == 'strata-studio-namespace-mode-approval/1' and p['action'] == 'install-unapproved-namespace-mode' and
           p['transition_id'] == op.plan['transition_id'] and p['package_sha256'] == op.digest, 'OWNER_APPROVAL_BINDING')
    for field in ['credential_generation_evidence_sha256', 'provider_conformance_evidence_sha256']:
        value = p[field]
        t.need(type(value) is str and len(value) == 64 and all(c in '0123456789abcdef' for c in value) and value != '0'*64, 'ACTIVATION_PREREQUISITE')
    t.need(p['credential_generation_evidence_sha256'] == t.sha(op.raw['saved-credential-version.json']), 'SAVED_CREDENTIAL_APPROVAL_BINDING')
    t.need(p['provider_conformance_evidence_sha256'] == t.sha(op.raw['provider-conformance.json']), 'PROVIDER_CONFORMANCE_APPROVAL_BINDING')
    begin = t.when(p['approved_at']); end = t.when(p['expires_at'])
    t.need(begin <= t.utc() < end and 0 < (end-begin).total_seconds() <= 900, 'OWNER_APPROVAL_EXPIRED')
    return t.sha(raw)


def preflight(target, op, live, validator=validate):
    t = target.t; layout(t, target, op); uid = live.uid()
    t.need(type(uid) is int and uid > 0, 'SERVICE_IDENTITY')
    host = t.read_file(target.host, 16384)
    t.need(t.sha(host) == op.plan['before_host_sha256'] and t.strict_json(host) == op.plan['before_host'], 'HOST_CHANGED')
    manifest = t.strict_json(t.read_file(target.etc/'release-manifest.json', 32768))
    t.need(manifest['source_commit'] == SOURCE, 'DEPLOYED_SOURCE_CHANGED')
    for filename in [target.lock, target.old.lock, target.old.recovery_lock, target.old.recovery,
                     target.etc/'.code-deployment.lock', target.etc/'owner-control.json.lock']:
        t.need(not filename.exists() and not filename.is_symlink(), 'OTHER_OPERATOR_BUSY')
    for filename in [target.intent, target.result, *map(pathlib.Path, op.plan['namespace'].values())]:
        t.need(not filename.exists() and not filename.is_symlink(), 'TRANSITION_ALREADY_EXISTS')
    # This operator is the FIRST managed-to-namespace transition only. A new UUID
    # after rollback must not obtain a fresh allowance while another namespace's
    # spending/private history remains. Later lineage reconciliation is separate.
    for root, pattern in [(target.etc, 'namespace-mode-*-intent.json'), (target.etc, 'namespace-policy-*.json'),
                          (target.private, 'namespace-catalog-*'), (target.private, 'namespace-projects-*')]:
        t.need(not any(root.glob(pattern)), 'NAMESPACE_LINEAGE_ALREADY_RETAINED')
    before, values = capture(target, op, uid); proof = validator(target, op, values)
    # Restoring the already expired managed configuration cannot renew TLS access.
    t.need(t.when(values['policy']['valid_until']) <= t.utc(), 'PREDECESSOR_NOT_EXPIRED')
    t.need(proof['state']['approved'] is False and proof['state']['connected'] is False and proof['state']['revoked'] is False and
           proof['usage']['reserved_requests'] == 0 and proof['usage']['reserved_bytes'] == 0, 'INITIAL_AUTHORITY')
    return uid, host, before, proof


def rollback_custody_equal(target, before, current):
    # Sign-in atomically replaces login-limit.json and changes its parent
    # directory's size/times. Those records MUST be retained, never restored.
    # All other owner identity files, control, keys, credentials and accounting
    # stay exact. owner_metadata already enforces safe UID/mode/nlink/no links.
    if before['hashes'] != current['hashes']: return False
    for name in ['security', 'credentials']:
        if before['metadata'][name] != current['metadata'][name]: return False
    root = str(target.private/'owner'); login = str(target.private/'owner/login-limit.json')
    left = before['metadata']['owner']; right = current['metadata']['owner']
    if left[root][:5] != right[root][:5] or login in left and login not in right: return False
    return {k: v for k, v in left.items() if k not in [root, login]} == {k: v for k, v in right.items() if k not in [root, login]}


def service_running(live):
    values = dict(line.split('=', 1) for line in live.run('show', 'strata-studio.service', '-p', 'ActiveState', '-p', 'MainPID').splitlines())
    return values.get('ActiveState') == 'active' and values.get('MainPID', '0') != '0'


def restore_configuration(target, op, live, intent, hook=lambda _: None):
    t = target.t; current = t.read_file(target.host, 16384)
    t.need(t.sha(current) in [intent['before_host_sha256'], intent['after_host_sha256']], 'ROLLBACK_HOST_CHANGED')
    # DynamicUser's NSS record may disappear while the service is stopped.
    # Use the durable UID and verify actual retained file ownership instead.
    uid = intent['service_uid']; t.need(target.private.lstat().st_uid == uid, 'SERVICE_IDENTITY_CHANGED')
    try:
        # Refuse before disrupting a running service. Repeat after the verified
        # stop to close the inspection/stop race, accepting only login metadata.
        before, _ = capture(target, op, uid)
        t.need(rollback_custody_equal(target, intent['custody'], before), 'PREDECESSOR_CHANGED')
        t.verified_stop(live); hook('rollback-stopped')
        t.need(t.read_file(target.host, 16384) == current, 'ROLLBACK_HOST_CHANGED')
        frozen, _ = capture(target, op, uid)
        t.need(rollback_custody_equal(target, intent['custody'], frozen), 'PREDECESSOR_CHANGED')
        # Restore only original host bytes. No private files, tombstones, grants,
        # budgets, policies, login history or namespace allowance are restored.
        t.write_file(target.host, bytes.fromhex(intent['before_host_hex']), mode=0o644, hook=hook, stage='rollback-host')
        t.write_file(target.result, t.encoded({'format': 'strata-studio-namespace-mode-result/1', 'status': 'rolled-back',
            'transition_id': op.plan['transition_id'], 'package_sha256': op.digest, 'namespace_state_retained': True}), hook=hook, stage='rollback-result')
        live.start(); live.ready(); t.need(live.uid() == uid, 'SERVICE_IDENTITY_CHANGED'); hook('rollback-ready')
    except Exception:
        # A raced refusal must not turn into an avoidable outage. Resume only an
        # unchanged, previously verified host configuration; never start a third
        # party's changed config or restore private state to make startup pass.
        if not service_running(live):
            resumed = t.read_file(target.host, 16384)
            t.need(resumed in [current, bytes.fromhex(intent['before_host_hex'])], 'ROLLBACK_RESUME_CONFIG_CHANGED')
            try: live.start(); live.ready()
            except Exception as error: raise t.Refused('ROLLBACK_RESUME_FAILED') from error
        raise


def apply(target, op, live, validator=validate, hook=lambda _: None):
    t = target.t; approval_sha = owner_approval_after_layout(target, op)
    uid, host, before, proof = preflight(target, op, live, validator)
    lease = t.encoded({'transition_id': op.plan['transition_id'], 'package_sha256': op.digest, 'process': t.process_identity()})
    t.write_file(target.lock, lease, exclusive=True); stopped = False; intent = None
    try:
        # Intent is durable BEFORE stop or any namespace/configuration write.
        after = t.encoded(proof['host'])
        intent = {'format': 'strata-studio-namespace-mode-intent/1', 'transition_id': op.plan['transition_id'],
            'package_sha256': op.digest, 'approval_sha256': approval_sha, 'service_uid': uid, 'custody': before,
            'before_host_hex': host.hex(), 'before_host_sha256': t.sha(host), 'after_host_sha256': t.sha(after),
            'prior_spending': proof['prior_spending'], 'total_limits': proof['total_limits'], 'policy_sha256': proof['policy_sha256']}
        t.write_file(target.intent, t.encoded(intent), exclusive=True); hook('intent-durable')
        stopped = True; t.verified_stop(live); hook('service-stopped')
        t.need(t.read_file(target.host, 16384) == host and target.private.lstat().st_uid == uid, 'FROZEN_HOST_CHANGED')
        frozen, values = capture(target, op, uid); t.need(frozen == before, 'FROZEN_CUSTODY_CHANGED')
        t.need(validator(target, op, values) == proof, 'FROZEN_PREPARATION_CHANGED')
        owner_approval(target, op)
        ns = {k: pathlib.Path(v) for k, v in op.plan['namespace'].items()}
        for key in ['catalog_directory', 'projects_directory']:
            t.create_dir(ns[key], uid, hook, key)
        for name, value in [('namespace.json', proof['state']), ('usage.json', proof['usage'])]:
            t.write_file(ns['catalog_directory']/name, t.encoded(value), owner=uid, exclusive=True, hook=hook, stage=name)
        t.write_file(ns['policy_file'], t.encoded(proof['policy']), mode=0o644, exclusive=True, hook=hook, stage='namespace-policy')
        # The only existing file changed by this operator.
        t.write_file(target.host, after, mode=0o644, hook=hook, stage='namespace-host')
        live.start(); hook('service-started'); live.ready(); hook('service-ready')
        t.need(live.uid() == uid and capture(target, op, uid)[0] == before, 'FINAL_CUSTODY_CHANGED')
        t.need(t.read_file(target.host, 16384) == after, 'FINAL_HOST_CHANGED')
        t.write_file(target.result, t.encoded({'format': 'strata-studio-namespace-mode-result/1', 'status': 'installed-unapproved',
            'transition_id': op.plan['transition_id'], 'package_sha256': op.digest, 'prior_spending': proof['prior_spending'],
            'policy_sha256': proof['policy_sha256'], 'provider_dispatches': 0, 'credential_contents_read': False}), hook=hook, stage='result')
        return {'status': 'installed-unapproved', 'provider_dispatches': 0, 'credential_contents_read': False}
    except Exception:
        if stopped and intent is not None:
            restore_configuration(target, op, live, intent, hook)
        raise
    finally:
        t.need(t.read_file(target.lock, 4096, exact_mode=0o600) == lease, 'OPERATOR_LEASE_CHANGED')
        target.lock.unlink(); t.sync_dir(target.etc)


def owner_approval_after_layout(target, op):
    layout(target.t, target, op); return owner_approval(target, op)


def rollback(target, op, live, expected_lease_sha=None, hook=lambda _: None):
    t = target.t; layout(t, target, op)
    # Exact reviewed intent, no credentials or fresh provider authority required.
    intent = t.strict_json(t.read_file(target.intent, 256*1024, exact_mode=0o600))
    t.need(intent['format'] == 'strata-studio-namespace-mode-intent/1' and intent['transition_id'] == op.plan['transition_id'] and
           intent['package_sha256'] == op.digest and t.sha(bytes.fromhex(intent['before_host_hex'])) == op.plan['before_host_sha256'], 'ROLLBACK_BINDING')
    if target.lock.exists() or target.lock.is_symlink():
        raw = t.read_file(target.lock, 4096, exact_mode=0o600)
        t.need(t.sha(raw) == expected_lease_sha, 'EXACT_STALE_LEASE_REQUIRED')
        lease = t.strict_json(raw)
        t.need(lease['transition_id'] == op.plan['transition_id'] and lease['package_sha256'] == op.digest, 'OPERATOR_LEASE_CHANGED')
        old = lease['process']
        try: current = t.process_identity(old['pid'])
        except (FileNotFoundError, ProcessLookupError): current = None
        # Running/sleeping state can change; PID/start/boot identify the writer.
        same = current and all(current[k] == old[k] for k in ['pid', 'start_ticks', 'boot_id'])
        t.need(not same, 'OPERATOR_STILL_RUNNING')
        target.lock.unlink(); t.sync_dir(target.etc)
    lease = t.encoded({'transition_id': op.plan['transition_id'], 'package_sha256': op.digest, 'process': t.process_identity()})
    t.write_file(target.lock, lease, exclusive=True)
    try: restore_configuration(target, op, live, intent, hook)
    finally:
        t.need(t.read_file(target.lock, 4096, exact_mode=0o600) == lease, 'OPERATOR_LEASE_CHANGED')
        target.lock.unlink(); t.sync_dir(target.etc)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['preflight', 'apply', 'rollback'])
    parser.add_argument('--helper', required=True); parser.add_argument('--package', required=True)
    parser.add_argument('--package-sha256', required=True); parser.add_argument('--expected-stale-lease-sha256')
    args = parser.parse_args()
    try:
        if os.geteuid() != 0 or sys.platform != 'linux': raise RuntimeError('Linux root operator required')
        t = load_helper(args.helper); target = Target(t); op = Package(t, args.package, args.package_sha256); live = t.Live()
        if args.action == 'preflight':
            _, _, _, proof = preflight(target, op, live)
            result = {'status': 'preflight-only', 'prior_spending': proof['prior_spending'], 'provider_dispatches': 0, 'credential_contents_read': False}
        elif args.action == 'apply': result = apply(target, op, live)
        else:
            rollback(target, op, live, args.expected_stale_lease_sha256)
            result = {'status': 'rolled-back', 'namespace_state_retained': True, 'credential_contents_read': False}
        print(json.dumps(result)); return 0
    except Exception as error:
        print(json.dumps({'status': 'refused', 'code': getattr(error, 'code', 'NAMESPACE_MODE_FAILED'),
                          'credential_contents_read': False, 'provider_dispatches': 0})); return 1


if __name__ == '__main__': raise SystemExit(main())
