import { createCloudflareDiscoveryHandler,type VerifiedDiscoveryPermission } from '../../src/agent-adapters/cloudflare.js';

// Mount only in a separately approved existing service. There is intentionally
// no default secret, deployed URL, fixture issuer, Agent instance creation,
// model client or executable task route in this starter.
export function discoveryStarter(
  origin:string,
  authorize:(request:Request)=>Promise<VerifiedDiscoveryPermission|undefined>,
){
  return createCloudflareDiscoveryHandler({origin,pathname:'/strata-discovery',authorize,
    advertisedFeatures:async()=>['published-intent-discovery']});
}
