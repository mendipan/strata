// Existing authenticated Studio routes and original-key recovery; no host setup.
import {canonicalDigest} from './draft-model.js';
const hash = value => /^[a-f0-9]{64}$/.test(value ?? '');
const same = (a, b) => a?.release_ref === b?.release_ref && a?.profile_ref === b?.profile_ref
  && a?.destination?.kind === 'local' && b?.destination?.kind === 'local'
  && a.destination.slot_id === b.destination.slot_id;
export function buildApi(ctx) {
  const read = async (route, input = {}, options) => {
    ctx.check();
    const result = await ctx.workRead(route, Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)), options);
    ctx.check(); return result;
  };
  return {
    canStart: () => {
      const row = ctx.workflow?.operations?.find(r => r.operation === 'build.start');
      return row?.allowed === true && row.configured === true && row.supported === true;
    },
    context: async (input = {}, options) => {
      // Explicit context reload establishes CAS pins. Prepare/start never rebind.
      if (!input.cursor) await ctx.profileBinding?.(options);
      return read('build/context', input, options);
    },
    prepare: (input, options) => read('build/preview', input, options),
    // Pagination stays within the context's existing repository/CAS binding.
    listProfiles: (input = {}, options) => read('profiles', input, options),
    inspectBuild: (input, options) => read('build/status', input, options),
    outputs: (input, options) => read('build/outputs', input, options),
    startBuild: async input => {
      ctx.check();
      const result = await ctx.command('build.start', input, {confirm: async (run, receipt) => {
        if (run?.format !== 'strata-build-run/1' || !hash(run.build_id)
          || run.project_id !== ctx.state.project_id || run.repository_id !== ctx.state.repository_id
          || run.plan_sha256 !== input.expected_plan_sha256 || !same(run.plan?.selection, input.selection)
          || run.plan?.project_id !== run.project_id || run.plan?.repository_id !== run.repository_id
          || run.plan?.release?.ref !== input.selection.release_ref || run.plan?.profile?.ref !== input.selection.profile_ref
          || !receipt?.key || run.request_key !== receipt.key
          || !hash(run.request_sha256) || typeof run.actor !== 'string'
          || !Array.isArray(run.events) || !run.events.length
          || typeof run.verification?.bytes !== 'boolean'
          || ![true,false,null].includes(run.verification?.mechanical)
          || run.verification?.fresh_semantic_validation !== false
          || run.phase === 'completed' && (run.verification.bytes !== true || run.verification.mechanical !== true
            || !run.realization?.ref || !run.host_run?.ref || !Array.isArray(run.inventory) || !run.inventory.length)
          || run.error?.code === 'BUILD_RECONCILIATION_REQUIRED' && !['completed','failed','interrupted','output_incomplete'].includes(run.phase)
          || !['accepted','materializing','exporting','verifying_bytes','checking','completed','failed','interrupted','output_incomplete'].includes(run.phase)) return false;
        const actual = await canonicalDigest(run.plan); ctx.check();
        const request = await canonicalDigest(input);
        const build = await canonicalDigest({project_id:run.project_id,repository_id:run.repository_id,actor:run.actor,request_key:receipt.key,request_sha256:request});
        ctx.check();
        return actual === input.expected_plan_sha256 && request === run.request_sha256 && build === run.build_id;
      }});
      ctx.check(); return result.data;
    },
    download: (input, options) => ctx.buildDownload(input, options),
  };
}
