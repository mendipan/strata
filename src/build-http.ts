import type { IncomingMessage, ServerResponse } from 'node:http';
import { validateEnvelope, MAX_REQUEST_BYTES, type SecurityContext } from './security.js';
import { fail, StrataError } from './model.js';
import { LOCAL_BUILD_OPERATIONS } from './build-operations.js';
import type { LocalBuildRepository } from './build-repository-node.js';

export type LocalBuildHttpAuthority = {
  // Host's existing named actor/parent session resolver. Never JSON identity.
  resolve(request: IncomingMessage): Promise<SecurityContext>;
  // Host must supply its existing same-origin + CSRF gate before browser use.
  authorizeBrowserRequest?: (request: IncomingMessage) => Promise<void>;
};
/** Mount inside the authenticated host; owns no login, policy or HTTP listener. */
export function localBuildHttpHandler(repository: LocalBuildRepository, authority: LocalBuildHttpAuthority, operationPath = '/v1/operation') {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://local.invalid');
    const download = url.pathname === operationPath + '/outputs';
    if (url.pathname !== operationPath && !download) return false;
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    try {
      if (request.headers.origin || request.headers['sec-fetch-site'] || request.headers.cookie) {
        if (!authority.authorizeBrowserRequest) fail('OPERATION_FORBIDDEN', 4, 'Browser build requests require the configured host origin and CSRF gate.');
        await authority.authorizeBrowserRequest(request);
      }
      const context = await authority.resolve(request);
      if (context.trust_mode !== 'host_authenticated') fail('AUTHENTICATION_REQUIRED', 4, 'Local builds require a current host-authenticated actor.');
      if (download) {
        if (request.method !== 'GET' || [...url.searchParams.keys()].some(k => !['build_id', 'file_id'].includes(k)) || url.searchParams.getAll('build_id').length !== 1 || url.searchParams.getAll('file_id').length !== 1) fail('INVALID_ARGUMENT', 2, 'Download requires one exact build and opaque file ID.');
        const build = url.searchParams.get('build_id')!, file = url.searchParams.get('file_id')!;
        if (![build, file].every(id => /^[a-f0-9]{64}$/.test(id))) fail('OUTPUT_LOCATOR_INVALID', 4, 'Download locator is invalid.');
        const bytes = await repository.download(build, file, context);
        response.setHeader('content-type', 'application/octet-stream');
        response.setHeader('content-disposition', 'attachment');
        response.end(bytes); return true;
      }
      if (request.method !== 'POST' || url.search || request.headers['content-type'] !== 'application/json') fail('INVALID_ARGUMENT', 2, 'Local build operations require one JSON POST envelope.');
      let text = '', bytes = 0;
      for await (const part of request) { bytes += Buffer.byteLength(part); if (bytes > MAX_REQUEST_BYTES) fail('INVALID_ARGUMENT', 2, 'Build operation exceeds the request byte bound.'); text += part; }
      const envelope = validateEnvelope(text);
      if (!LOCAL_BUILD_OPERATIONS.includes(envelope.command)) fail('UNSUPPORTED_CAPABILITY', 8, 'This authenticated adapter does not expose that operation.');
      if (envelope.options?.fault) fail('OPERATION_FORBIDDEN', 4, 'Client fault injection is unavailable.');
      const result = await repository.execute(envelope.command, envelope.input, context, {
        key: envelope.options?.idempotency_key, dry_run: envelope.options?.dry_run,
        expected_generation: request.headers['x-strata-expected-generation'] ? String(request.headers['x-strata-expected-generation']) : undefined,
        expected_policy: request.headers['x-strata-expected-policy'] ? String(request.headers['x-strata-expected-policy']) : undefined,
      });
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result));
    } catch (error) {
      const e = error instanceof StrataError ? error : new StrataError('STORE_UNAVAILABLE', 9, 'Local build outcome is unavailable; inspect the original request before retrying.');
      response.setHeader('content-type', 'application/json');
      response.statusCode = e.exit === 4 ? 403 : e.exit === 5 || e.exit === 6 ? 409 : e.exit === 9 ? 503 : 422;
      response.end(JSON.stringify({ ok: false, error: { code: e.code, exit: e.exit, message: e.message, details: e.details } }));
    }
    return true;
  };
}
