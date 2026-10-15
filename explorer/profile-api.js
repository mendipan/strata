// Profiles use the shell's authenticated reads, CAS binding and original-key
// recovery. This adapter has no transport, credentials or storage of its own.
import {canonicalDigest} from './draft-model.js';
export function profileApi(ctx) {
  const read = async (route, input, options) => {
    ctx.check();
    const params = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
    const result = await ctx.workRead(route, params, options);
    ctx.check();
    return result;
  };
  const write = async (name, input) => {
    ctx.check();
    const result = await ctx.command(name, input, {confirm: async reply => {
      const record = reply?.record;
      if (!record || !ctx.state.project_id || !ctx.state.repository_id) return false;
      const matches = record.project_id === ctx.state.project_id && record.repository_id === ctx.state.repository_id
        && typeof reply.ref === 'string' && /^build-profile@[a-f0-9]{64}$/.test(reply.ref)
        && /^[a-f0-9]{64}$/.test(reply.sha256 ?? '')
        && reply.ref === 'build-profile@' + reply.sha256
        && Object.keys(input.record).every(key => JSON.stringify(record[key]) === JSON.stringify(input.record[key]))
        && (name === 'profile.create' ? record.previous === null : record.previous?.ref === input.previous)
        && reply.report?.normalized_sha256 === input.expected_normalized_sha256;
      if (!matches) return false;
      const actual = await canonicalDigest(record);
      ctx.check();
      return actual === reply.sha256;
    }});
    ctx.check();
    return result.data;
  };
  return {
    compatibility: (input = {}, options) => read('repository/compatibility', input, options),
    listProfiles: async (input = {}, options) => {
      const page = await read('profiles', input, options);
      // An explicit list/reload establishes the next editing snapshot. Save's
      // compatibility and validate reads never replace its CAS preconditions.
      await ctx.profileBinding?.(options);
      ctx.check();
      return page;
    },
    inspectProfile: (input, options) => read('profiles/record', input, options),
    validateProfile: (input, options) => read('profiles/validate', input, options),
    createProfile: input => write('profile.create', input),
    reviseProfile: input => write('profile.revise', input),
  };
}
