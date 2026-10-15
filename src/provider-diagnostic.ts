// Provider messages may contain credentials or user content. Export only fixed
// classifications and numeric codes; never export the raw message or stack.
export type ProviderDiagnostic = {
  stage: string; category: 'subrequest-limit' | 'cpu-limit' | 'authentication' | 'rate-limit' | 'timeout' | 'connection' | 'disposed' | 'unknown';
  status?: number; code?: number; process_killed?: boolean; signal?: string;
};
export function isProviderDiagnostic(value: unknown): value is ProviderDiagnostic {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).every(k => ['stage', 'category', 'status', 'code', 'process_killed', 'signal'].includes(k)) &&
    typeof v.stage === 'string' && /^(?:read\.(?:get|info|file|body)|batch\.(?:get|info|create-token|push|read-back)|wrangler\.[a-z-]{1,32})$/.test(v.stage) &&
    ['subrequest-limit','cpu-limit','authentication','rate-limit','timeout','connection','disposed','unknown'].includes(String(v.category)) &&
    (v.status === undefined || Number.isInteger(v.status) && Number(v.status) >= 400 && Number(v.status) < 600) &&
    (v.code === undefined || Number.isSafeInteger(v.code)) && (v.process_killed === undefined || typeof v.process_killed === 'boolean') &&
    (v.signal === undefined || ['SIGTERM','SIGKILL','SIGABRT','SIGINT'].includes(String(v.signal)));
}
export function providerDiagnostic(stage: string, error: unknown): ProviderDiagnostic {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const text = [value.message, value.stderr].filter((v): v is string => typeof v === 'string').join('\n').slice(0, 256 * 1024);
  const category = /too many subrequests|subrequest.{0,40}limit/i.test(text) ? 'subrequest-limit'
    : /exceeded CPU|CPU time limit/i.test(text) ? 'cpu-limit'
    : /authentication error|unauthorized|invalid.{0,16}token|token.{0,16}expired/i.test(text) ? 'authentication'
    : /rate.?limit|too many requests/i.test(text) ? 'rate-limit'
    : /timed? ?out|timeout|deadline/i.test(text) ? 'timeout'
    : /disconnected|connection|network|socket|fetch failed/i.test(text) ? 'connection'
    : /disposed|RPC target.{0,40}(?:not found|no longer)/i.test(text) ? 'disposed' : 'unknown';
  const status = typeof value.status === 'number' ? value.status : Number(text.match(/(?:HTTP\s+|status(?: code)?[\s:=]+)([45]\d{2})\b/i)?.[1]);
  const code = typeof value.code === 'number' ? value.code : Number(text.match(/\[code:\s*(\d{1,8})\]/)?.[1]);
  return { stage, category, ...(Number.isInteger(status) && status >= 400 && status < 600 ? { status } : {}),
    ...(Number.isSafeInteger(code) ? { code } : {}), ...(typeof value.killed === 'boolean' ? { process_killed: value.killed } : {}),
    ...(['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGINT'].includes(String(value.signal)) ? { signal: String(value.signal) } : {}) };
}
