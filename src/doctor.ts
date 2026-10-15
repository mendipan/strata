import { cliBroker } from './cli-config.js';
import { StrataError } from './model.js';
import { PROFILE_IDS, compatibleProfile } from './profile.js';

type Check = { id: string; status: 'passed' | 'failed' | 'unavailable' | 'not_checked'; message: string; code?: string; next_action?: string };
export async function doctor(config: any, offline: boolean, cliCapabilities: Record<string, unknown>, configurationError?: StrataError) {
  const checks: Check[] = [];
  let broker: URL | undefined;
  let failureExit = 0;
  try {
    if (configurationError) throw configurationError;
    broker = cliBroker(config);
    checks.push({ id: 'configuration', status: 'passed', message: 'Configuration passes the existing local CLI admission checks.' });
  } catch (error) {
    const failure = error as StrataError;
    failureExit = failure.exit;
    checks.push({ id: 'configuration', status: 'failed', code: failure.code, message: failure.message, next_action: 'Have the host inspect strata.config.json; doctor makes no repairs.' });
  }
  if (broker) {
    checks.push({ id: 'profiles', status: Array.isArray(config.profiles) && config.profiles.length > 0 && config.profiles.every((id: string) => PROFILE_IDS.includes(id) && compatibleProfile(id, config.model_version)) ? 'passed' : 'failed', message: 'Configured profiles must support the configured model; runtime execution support is checked separately by existing operations.' });
    // cliBroker admits an omitted client identity label. Both FixtureIssuer and
    // explicitly configured HostIssuer resolve local sessions on the server;
    // neither a config label nor /health can establish the current authority.
    const declared = config.identity_policy;
    checks.push({ id: 'identity_policy',
      status: declared === undefined ? 'not_checked' : declared === 'trusted-local-fixture-sessions' ? 'passed' : 'failed',
      message: declared === undefined
        ? 'No client identity policy is declared. The loopback broker resolves sessions through its configured issuer; doctor does not inspect the issuer, session, accounts or grants.'
        : declared === 'trusted-local-fixture-sessions'
          ? 'The declared fixture session policy is supported by the local CLI. Actual broker authority and current caller permission are not checked.'
          : 'The declared identity policy is unsupported for this local loopback transport.' });
  }
  let health: any = null;
  let probed = false;
  if (!broker || offline) checks.push({ id: 'broker_health', status: 'not_checked', message: offline ? 'Offline mode skips the loopback health probe.' : 'Configuration failed; no broker was contacted.' });
  else {
    probed = true;
    try {
      const response = await fetch(new URL('/health', broker), { redirect: 'error', signal: AbortSignal.timeout(2000) });
      // Limit bytes while streaming; a local server must not supply unbounded diagnostics.
      const reader = response.body?.getReader(); let text = '';
      if (reader) try {
        let bytes = 0; const decoder = new TextDecoder();
        while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 4096) throw new Error('oversized'); text += decoder.decode(chunk.value, { stream: true }); }
        text += decoder.decode();
      } finally { await reader.cancel(); }
      try { health = JSON.parse(text); } catch { health = null; }
      if (!response.ok || health?.local !== true) checks.push({ id: 'broker_health', status: 'failed', message: 'The loopback endpoint did not return a successful local Strata health response.' });
      else checks.push({ id: 'broker_health', status: 'passed', message: 'The loopback endpoint reports local health; this does not verify stored records, permissions or execution.' });
    } catch {
      health = null;
      checks.push({ id: 'broker_health', status: 'unavailable', message: 'Loopback health could not be read within the bounded probe.', next_action: 'Have the host inspect the local broker; doctor does not start it.' });
    }
  }
  const failed = checks.some(check => check.status === 'failed');
  return { format: 'strata-doctor/1', checks, configuration_healthy: !!broker && !checks.some(check => check.id !== 'broker_health' && check.status === 'failed'),
    capabilities: { cli_support: cliCapabilities, supported_cli_profiles: PROFILE_IDS, configured_profiles: broker && Array.isArray(config.profiles) ? config.profiles : [],
      runtime: health?.local === true ? health.runtime === 'node-development-harness' ? 'node-development-harness' : 'local-runtime-reported' : null,
      runtime_capabilities: 'not_checked' },
    verification: [
      { id: 'content_binding', status: 'not_checked', message: 'Existing validation binds candidate/profile/output and, for profiles 3/4, checker/fixture/oracle digests. Doctor checks no candidate or artifact.' },
      { id: 'execution', status: 'not_checked', message: 'No tests, generated implementation, agents or operator approvals were run.' },
      { id: 'independent_attestation', status: 'unavailable', message: 'Configuration labels and imported evidence do not authenticate independent execution or human review. A hash does not prove a test ran.' },
      { id: 'hosted_identity', status: 'not_checked', message: 'Doctor does not authenticate a caller or inspect the broker issuer, accounts, policy or current grants. Use a separately authorized runtime read to check current permission.' }
    ], probed, failure_exit: failed ? failureExit || 2 : 0 };
}
