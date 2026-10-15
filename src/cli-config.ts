import { fail, SUPPORTED_MODELS } from './model.js';

// Shared admission checks only: no probes, mutation or credential handling.
export function cliBroker(config: any): URL {
  const keys = ['schema_version', 'model_version', 'project_id', 'broker', 'artifact_adapter', 'profiles', 'identity_policy', 'network_policy'];
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(k => !keys.includes(k)) || config.schema_version !== '1' || !SUPPORTED_MODELS.includes(config.model_version)) fail('UNSUPPORTED_MODEL_VERSION', 8, 'Use the published experimental local configuration schema.');
  if (config.artifact_adapter !== 'local-persistent-fake' || config.network_policy !== 'loopback-only') fail('COST_APPROVAL_REQUIRED', 7, 'Remote adapters and network policies are disabled.');
  let broker: URL; try { broker = new URL(config.broker); } catch { fail('INVALID_ARGUMENT', 2, 'Broker URL is invalid.'); }
  if (broker.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(broker.hostname) || broker.username || broker.password || broker.pathname !== '/' || broker.search || broker.hash) fail('NETWORK_FORBIDDEN', 7, 'Only a plain loopback broker is allowed.');
  return broker;
}
