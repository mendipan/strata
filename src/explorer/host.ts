import type { ActorAccess } from '../auth/access.js';
import {CredentialApi} from './credential-api.js';
import { StudioCommands, studioBody, studioFailure } from './commands.js';
import { createServer, type IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { API_VERSION, ExplorerError, LIMITS, READ_ROUTES, problem } from './contract.js';
import { ExplorerReader } from './read.js';
import { defaultConnections, type ExplorerConnections } from './connections.js';
import { HostedAccess, type HostedOptions, type HostedReadAccess } from './hosted.js';
import { OwnerAccess } from './owner-access.js';
import type { StudioAgentHttp } from '../studio-agents/http.js';

const queryKeys: Record<string,string[]> = { settings: [], connection: [], records:['type','baseline','target','limit','cursor','generation'], record:['type','ref','generation'], blocks:['at','text','facets','match','authority','limit','cursor','generation'], block:['at','id','generation'], relations:['at','id','limit','cursor','generation'], evaluation:['ref','generation'], diff:['left','right','all','limit','cursor','generation'], refresh:[] };
const files: Record<string,string> = { '/':'index.html', '/index.html':'index.html', '/favicon.svg':'favicon.svg', '/app.js':'app.js', '/dom.js':'dom.js', '/blocks.js':'blocks.js', '/records.js':'records.js', '/compare.js':'compare.js', '/style.css':'style.css' };
  for (const module of ['build','build-api','profiles','profile-api','agent-workspace','agent-setup','namespace-settings','connection-feedback','repository-switcher','session','workspace-session','workspace-settings','credentials','setup','owner-session','owner-credentials', 'agent-settings', 'connections', 'semantic-model', 'application-map', 'proposals', 'readable', 'draft-model', 'workflow','operation-recovery']) files[`/${module}.js`] = `${module}.js`;
const headers = { 'cache-control':'no-store', 'x-content-type-options':'nosniff', 'referrer-policy':'no-referrer', 'content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", 'cross-origin-resource-policy':'same-origin' };
async function emptyBody(req: IncomingMessage) {
  let size=0; const chunks:Buffer[]=[];
  for await (const chunk of req) { size+=chunk.length; if(size>LIMITS.bodyBytes) problem('INVALID_INPUT',413,'Refresh body exceeds its limit.'); chunks.push(chunk); }
  const text=Buffer.concat(chunks).toString('utf8'); if(text!=='{}') problem('INVALID_INPUT',400,'Refresh accepts one empty JSON object.');
}
async function settingsBody(req: IncomingMessage,maximum:number=LIMITS.bodyBytes) {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > maximum) problem('INVALID_INPUT', 413, 'Settings body exceeds its limit.'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return problem('INVALID_INPUT', 400, 'Settings require a valid JSON action.'); }
}
export async function startExplorer(reader: ExplorerReader, options: { port?:number; assets:string; agentHttp?:StudioAgentHttp; sessionMs?:number; connections?: ExplorerConnections; hosted?: HostedOptions; owner?:OwnerAccess; commands?: StudioCommands; credentials?:CredentialApi; workspace?:{resolveActor?:(req:IncomingMessage)=>Promise<{access:ActorAccess;commands:(req:IncomingMessage)=>StudioCommands;connections:(req:IncomingMessage)=>ExplorerConnections}>;owner:OwnerAccess;current:(req:IncomingMessage)=>Promise<void>;actor:{access:ActorAccess;commands:(req:IncomingMessage)=>StudioCommands;connections:(req:IncomingMessage)=>ExplorerConnections}}; actor?:{access:HostedReadAccess;commands:(req:IncomingMessage)=>StudioCommands;connections:(req:IncomingMessage)=>ExplorerConnections} }) {
  if(options.hosted&&options.commands)throw new Error('Reader sessions cannot authorize hosted writes.');
  if(options.owner&&(options.hosted||options.actor||options.commands||options.credentials))throw new Error('Installation owner mode cannot mix reader, actor or legacy manager adapters.');
  if(options.workspace&&(options.owner||options.actor||options.hosted||options.commands||options.credentials))throw new Error('Workspace mode requires one explicit trusted factory.');
  const owner=options.workspace?.owner??options.owner,actor=options.workspace?.actor??options.actor;
  const defaultCatalog = options.connections ?? defaultConnections(reader);
  const hosted = owner ?? actor?.access ?? (options.hosted ? new HostedAccess(options.hosted) : undefined);
  const capability = hosted ? '' : Buffer.from(randomBytes(32)).toString('base64url'), expires=Date.now()+(options.sessionMs ?? 8*60*60*1000);
  let origin='';
  const server=createServer(async (req,res)=>{
    for(const [k,v] of Object.entries(headers)) res.setHeader(k,v);
    const requestId=Buffer.from(randomBytes(8)).toString('hex');
    try {
      if (hosted) hosted.boundary(req);
      else if(req.headers.host!==new URL(origin).host || (req.headers.origin!==undefined && req.headers.origin!==origin) || !['same-origin','none',undefined].includes(req.headers['sec-fetch-site'] as any) || req.headers['x-forwarded-host'] || req.headers['x-forwarded-for']) problem('LOCAL_ORIGIN',403,'This Studio accepts its local session only.');
      if(!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.length>LIMITS.queryBytes) problem('INVALID_INPUT',400,'Invalid Studio request.');
      const url=new URL(req.url!,origin), pathname=url.pathname;let connections=defaultCatalog;let commands=options.commands;let actor=options.workspace?.actor??options.actor;
      const cli=!options.workspace&&!!actor&&req.headers['x-studio-client']==='cli'&&!req.headers.origin&&!req.headers['sec-fetch-site']&&!req.headers.cookie;
      if(options.agentHttp&&await options.agentHttp.handle(req,res,url))return;
      const ownerRoutes=['/studio/session','/studio/setup','/studio/setup/outcome','/studio/setup/request','/studio/setup/cancel','/studio/setup/complete','/studio/setup/recover','/studio/owner/session','/studio/owner/login','/studio/owner/logout','/studio/owner/reauth','/studio/owner/password','/studio/v1/owner/credentials'];
      const ownerConnections=pathname==='/studio/v1/owner/connections',ownerOutcome=pathname.match(/^\/studio\/v1\/owner\/connections\/operations\/([a-f0-9-]{36})$/i);
      const ownerAgents=pathname==='/studio/v1/owner/agents',agentOutcome=pathname.match(/^\/studio\/v1\/owner\/agents\/operations\/([a-f0-9-]{36})$/i);
      if(owner&&(ownerRoutes.includes(pathname)||ownerConnections||ownerOutcome||ownerAgents||agentOutcome)){
        const read=['/studio/session','/studio/setup','/studio/setup/outcome','/studio/owner/session'].includes(pathname),credentials=pathname==='/studio/v1/owner/credentials';
        if(url.search||req.headers.authorization)problem('INVALID_INPUT',400,'Owner routes accept the protected browser session without query parameters.');
        if(credentials||ownerConnections||ownerAgents?!['GET','POST'].includes(req.method??''):req.method!==((read||ownerOutcome||agentOutcome)?'GET':'POST'))problem('METHOD_FORBIDDEN',405,'Unsupported owner method.');
        if(req.method==='POST'&&(req.headers.origin!==owner.origin||req.headers['content-type']!=='application/json'))problem('LOCAL_ORIGIN',403,'Owner actions require the configured HTTPS origin and JSON.');
        if(req.method==='GET'&&(req.headers['transfer-encoding']||(req.headers['content-length']&&req.headers['content-length']!=='0')))problem('INVALID_INPUT',400,'Owner status accepts no body.');
        const input=req.method==='POST'?await settingsBody(req,ownerConnections?256*1024:LIMITS.bodyBytes):undefined;
        if(pathname==='/studio/owner/logout'&&(!input||typeof input!=='object'||Object.keys(input).length))problem('INVALID_INPUT',400,'Sign-out requires an empty JSON object.');
        const waiting=new AbortController(),cancel=()=>{if(!res.writableEnded)waiting.abort();};
        if(ownerAgents&&req.method==='POST')res.once('close',cancel);
        let data:unknown;
        try{data=ownerAgents||agentOutcome?await owner.agents(req,input,agentOutcome?.[1],waiting.signal):ownerConnections||ownerOutcome?await owner.connections(req,input,ownerOutcome?.[1]):credentials?await owner.credentials(req,input):await owner.handle(req,res,pathname,input);}
        finally{res.removeListener('close',cancel);}
        if((ownerConnections||ownerOutcome||ownerAgents||agentOutcome)&&Buffer.byteLength(JSON.stringify(data))>65536)problem('VIEW_TOO_LARGE',413,'Connection settings exceed their bounded projection.');
        res.setHeader('content-type','application/json; charset=utf-8');res.end(JSON.stringify(data));return;
      }
      if(options.workspace?.resolveActor&&(pathname.startsWith('/studio/actor/')||pathname.startsWith('/studio/v1/')||pathname.startsWith('/explorer/v1/')))actor=await options.workspace.resolveActor(req);
      if(options.workspace&&['/studio/actor/session','/studio/actor/logout'].includes(pathname)){
        if(url.search||req.headers.authorization||req.headers['x-studio-client'])problem('INVALID_INPUT',400,'Actor exchange accepts its protected browser session.');
        if(pathname==='/studio/actor/logout'?req.method!=='POST':!['GET','POST'].includes(req.method??''))problem('METHOD_FORBIDDEN',405,'Unsupported actor session method.');
        if(req.method==='POST'&&(req.headers.origin!==owner!.origin||req.headers['content-type']!=='application/json'))problem('LOCAL_ORIGIN',403,'Actor exchange requires its exact HTTPS origin and JSON.');
        if(req.method==='GET'&&(req.headers['transfer-encoding']||req.headers['content-length']&&req.headers['content-length']!=='0'))problem('INVALID_INPUT',400,'Actor status accepts no body.');
        const access=actor!.access as ActorAccess;
        let data;if(req.method==='GET')data=access.status(req);else{const input=await settingsBody(req);if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)problem('INVALID_INPUT',400,'Actor exchange accepts one empty object.');data=pathname==='/studio/actor/logout'?access.logout(req,res):await access.exchangeOwner(req,res,input);}
        res.setHeader('content-type','application/json');res.end(JSON.stringify(data));return;
      }
      if(actor&&pathname==='/studio/cli/login'){if(!cli||url.search||req.method!=='POST'||req.headers.authorization||req.headers['content-type']!=='application/json')problem('LOCAL_ORIGIN',403,'CLI sign-in requires its explicit authenticated transport.');res.setHeader('content-type','application/json');res.end(JSON.stringify(actor.access.login(req,res,await settingsBody(req))));return;}
      if (hosted && ['/studio/session', '/studio/login', '/studio/logout'].includes(pathname)) {
        if (url.search || req.method !== (pathname === '/studio/session' ? 'GET' : 'POST')) problem('INVALID_INPUT', 400, 'Invalid Studio session request.');
        if (req.headers.authorization && !cli) problem('SESSION_REQUIRED', 401, 'Hosted Studio requires protected sign-in.');
        if (req.method === 'POST' && ((!cli&&req.headers.origin !== hosted.origin) || req.headers['content-type'] !== 'application/json')) problem('LOCAL_ORIGIN', 403, 'Studio sign-in requires its HTTPS origin and JSON.');
        if (req.method === 'GET' && (req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0'))) problem('INVALID_INPUT', 400, 'Session status accepts no body.');
        if(owner)problem('NOT_FOUND',404,'Use the owner sign-in form.');
        const data = pathname === '/studio/session' ? await hosted.status(req) : pathname === '/studio/login' ? await hosted.login(req, res, await settingsBody(req)) : (await emptyBody(req), await hosted.logout(req, res));
        res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(data)); return;
      }
      if(pathname==='/favicon.ico' && req.method==='GET' && !url.search) {res.statusCode=204;res.end();return;}
      if(Object.hasOwn(files,pathname)) {
        if(req.method!=='GET' || url.search) problem('INVALID_INPUT',400,'Invalid static request.');
        const file=files[pathname]; res.setHeader('content-type',file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':file.endsWith('.svg')?'image/svg+xml':'text/html; charset=utf-8');
        res.end(await readFile(path.join(options.assets,file))); return;
      }
      if (hosted && pathname === '/studio/v1/credentials') {
        if(owner)problem('NOT_FOUND',404,'Use owner credential settings.');
        if (url.search) problem('INVALID_INPUT',400,'Credential settings accept no query parameters.');
        if (!['GET','POST'].includes(req.method??'')) problem('METHOD_FORBIDDEN',405,'Credential settings require GET or POST.');
        if (req.headers.authorization) problem('SESSION_REQUIRED',401,'Credentials require the protected browser session.');
        await hosted.require(req);
        if (req.method==='POST'&&(req.headers.origin!==hosted.origin||req.headers['content-type']!=='application/json')) problem('LOCAL_ORIGIN',403,'Credential settings require configured HTTPS origin and JSON.');
        if (req.method==='GET'&&(req.headers['transfer-encoding']||(req.headers['content-length']&&req.headers['content-length']!=='0')))problem('INVALID_INPUT',400,'Credential status accepts no body.');
        const api=options.credentials??new CredentialApi();
        // An actor session alone supplies no credential-manager privilege.
        const data=req.method==='GET'?await api.status():await api.action(await settingsBody(req));
        res.setHeader('content-type','application/json; charset=utf-8');res.end(JSON.stringify(data));return;
      }
      const buildReads:Record<string,{command:string;keys:string[]}>={
        profiles:{command:'profile.list',keys:['contract_ref','limit','cursor']},'profiles/record':{command:'profile.inspect',keys:['ref']},
        'repository/compatibility':{command:'repository.compatibility',keys:['release_ref']},'build/context':{command:'build.context',keys:['release_ref','limit','cursor']},
        'build/status':{command:'build.inspect',keys:['build_id']},'build/outputs':{command:'build.outputs',keys:['build_id']},
      };
      const buildPosts:Record<string,string>={'profiles/validate':'profile.validate','build/preview':'build.prepare'};
      const studioRoutes=['capabilities','review/inbox','review/state','preview','operation','operation/status',...Object.keys(buildReads),...Object.keys(buildPosts),'build/output'];
      const studioRoute=pathname.startsWith('/studio/v1/')?pathname.slice('/studio/v1/'.length):'';
      if(studioRoutes.includes(studioRoute)) {
        if(hosted){await (actor?.access??hosted).require(req);if(!actor)problem('WRITE_UNAVAILABLE',403,'This hosted reader has no actor or write authority.');await options.workspace?.current(req);commands=actor.commands(req);}
        const expected=Buffer.from('Bearer '+capability),actual=Buffer.from(typeof req.headers.authorization==='string'?req.headers.authorization:'');
        if(!hosted&&(Date.now()>=expires||actual.length!==expected.length||!timingSafeEqual(actual,expected)))problem('SESSION_REQUIRED',401,'Open a new local session.');
        if(!commands)problem('WRITE_UNAVAILABLE',403,'This Studio session is read-only; no command adapter is configured.');
        const post=['preview','operation',...Object.keys(buildPosts)].includes(studioRoute);
        if(req.method!==(post?'POST':'GET'))problem('METHOD_FORBIDDEN',405,'Unsupported Studio method.');
        const permitted=buildReads[studioRoute]?.keys??(studioRoute==='build/output'?['build_id','file_id']:studioRoute==='review/inbox'?['baseline','limit','cursor']:studioRoute==='review/state'?['ref']:studioRoute==='operation/status'?['key']:[]);
        if([...url.searchParams.keys()].some(k=>!permitted.includes(k))||new Set(url.searchParams.keys()).size!==[...url.searchParams.keys()].length)problem('INVALID_INPUT',400,'Unsupported Studio query.');
        if(post&&((!cli&&req.headers.origin!==(hosted?.origin??origin))||req.headers['content-type']!=='application/json'))problem('LOCAL_ORIGIN',403,'Studio writes require their local origin and JSON.');
        if(studioRoute==='build/output') {
          if(req.headers['transfer-encoding']||req.headers['content-length']&&req.headers['content-length']!=='0')problem('INVALID_INPUT',400,'Downloads accept no body.');
          const buildId=url.searchParams.get('build_id')??'',fileId=url.searchParams.get('file_id')??'';
          if(![buildId,fileId].every(id=>/^[a-f0-9]{64}$/.test(id)))problem('INVALID_INPUT',400,'Choose one exact build and opaque file ID.');
          const bytes=await commands.downloadBuildOutput(buildId,fileId);
          res.setHeader('content-type','application/octet-stream');res.setHeader('content-disposition','attachment');res.end(bytes);return;
        }
        let data;
        if(post) {const input=await studioBody(req);data=studioRoute==='operation'?await commands!.operation(input):await commands!.read(buildPosts[studioRoute]??'layer.preview',input);}
        else {if(req.headers['transfer-encoding']||(req.headers['content-length']&&req.headers['content-length']!=='0'))problem('INVALID_INPUT',400,'Projection requests accept no body.');const input:any=Object.fromEntries(url.searchParams);if(input.limit!==undefined)input.limit=Number(input.limit);data=await commands!.read(buildReads[studioRoute]?.command??(studioRoute==='capabilities'?'capabilities':studioRoute==='review/inbox'?'review.inbox':studioRoute==='operation/status'?'operation.inspect':'review.state'),input);}
        const body=JSON.stringify({api_version:'studio/1',data});if(Buffer.byteLength(body)>LIMITS.responseBytes)problem('VIEW_TOO_LARGE',413,'Studio detail exceeds its response limit.');
        res.setHeader('content-type','application/json; charset=utf-8');res.end(body);return;
      }
      const route=pathname.startsWith('/explorer/v1/')?pathname.slice('/explorer/v1/'.length):pathname.startsWith('/studio/v1/')?pathname.slice('/studio/v1/'.length):'';
      // Positive method/route/key allowlist precedes any project/provider read.
      if(!(READ_ROUTES as readonly string[]).includes(route) && route!=='refresh' && route!=='settings') problem('NOT_FOUND',404,'Studio route is unavailable.');
      if(route==='settings' ? !['GET','POST'].includes(req.method ?? '') : req.method!==(route==='refresh'?'POST':'GET')) problem('METHOD_FORBIDDEN',405,'Only Studio read and connection session operations are available.');
      const keys=[...url.searchParams.keys()];
      if(keys.some(k=>!queryKeys[route].includes(k)) || new Set(keys).size!==keys.length || [...url.searchParams].some(([key,value])=>value.length>(key==='text'?256:key==='facets'?64:256)) || (url.searchParams.has('all') && !['true','false'].includes(url.searchParams.get('all')!))) problem('INVALID_INPUT',400,'Unsupported Studio query.');
      const supplied=req.headers.authorization;
      const expected=Buffer.from('Bearer '+capability), actual=Buffer.from(typeof supplied==='string'?supplied:'');
      if (hosted) { if (supplied&&!cli) problem('SESSION_REQUIRED', 401, 'Hosted Studio requires protected sign-in.'); await (actor?.access??hosted).require(req);await options.workspace?.current(req);if(actor)connections=actor.connections(req); }
      else if(Date.now()>=expires || actual.length!==expected.length || !timingSafeEqual(actual,expected)) problem('SESSION_REQUIRED',401,'Open a new local session. Use the private launch link from the local host.');
      let input: unknown;
      if(route==='refresh' || (route==='settings' && req.method==='POST')) {
        if((!cli&&req.headers.origin!==(hosted?.origin ?? origin)) || req.headers['content-type']!=='application/json') problem('LOCAL_ORIGIN',403,'Refresh requires the configured origin and JSON.');
        if (route === 'settings') input = await settingsBody(req); else await emptyBody(req);
      } else if(req.headers['content-length'] && req.headers['content-length']!=='0' || req.headers['transfer-encoding']) problem('INVALID_INPUT',400,'Read requests do not accept a body.');
      if(owner?.managedConnections){
        const manager=owner.managedConnections!;
        if(route==='settings'){
          if(req.method==='POST')problem('SOURCE_MANAGEMENT_REQUIRED',403,'Use owner connection Settings with a current revision and request ID.');
          const data=await owner.connections(req);res.setHeader('content-type','application/json');res.end(JSON.stringify({api_version:API_VERSION,data}));return;
        }
        if(route==='refresh')problem('SOURCE_MANAGEMENT_REQUIRED',403,'Use the explicit read test or reconnect action in owner Settings.');
        const result=await manager.read(owner.sourceAuthority(req),async selected=>({api_version:API_VERSION,connection_id:selected.source.connection.connection_id,project_id:selected.source.connection.project_id,model_version:selected.source.connection.model_version,source:selected.sourceInfo(),data:selected.query(route,url.searchParams)}));
        const body=JSON.stringify(result);if(Buffer.byteLength(body)>LIMITS.responseBytes)problem('VIEW_TOO_LARGE',413,'This detail exceeds the current view limit.');res.setHeader('content-type','application/json');res.end(body);return;
      }
      // A named actor's first explicit project read loads its pinned local state.
      // H1 provider reads still require their existing explicit test/refresh flow.
      if(actor&&route==='connection'&&!connections.reader().connection().ready)await connections.reader().refresh({signal:AbortSignal.timeout(10000)});
      const data=route==='settings' ? (req.method==='POST' ? await connections.action(input) : connections.status()) : route==='refresh'?await connections.reader().refresh({signal:AbortSignal.timeout(10000)}):connections.reader().query(route,url.searchParams);
      const current = connections.selectedReader;
      // Settings remain accessible after denied auth or a disconnect; metadata
      // is projected by the catalog rather than attempting another source read.
      const source=route==='settings' ? null : current.sourceInfo(), connection=current.source.connection;
      const body=JSON.stringify({ api_version:API_VERSION,connection_id:connection.connection_id,project_id:connection.project_id,model_version:connection.model_version,source,data });
      if(Buffer.byteLength(body)>LIMITS.responseBytes) problem('VIEW_TOO_LARGE',413,'This detail exceeds the current view limit.');
      res.setHeader('content-type','application/json; charset=utf-8'); res.end(body);
    } catch(error) {
      const domain=studioFailure(error);
      const safe=error instanceof ExplorerError?error:domain?new ExplorerError(domain.code,domain.status,domain.message):new ExplorerError('CORRUPT_DATA',422,'Project records could not be verified.');
      res.statusCode=safe.status; res.setHeader('content-type','application/json; charset=utf-8');
      res.end(JSON.stringify({api_version:API_VERSION,error:{code:safe.code,message:safe.message,retryable:safe.retryable,request_id:requestId}}));
    }
  });
  server.requestTimeout=10000; server.headersTimeout=10000; server.keepAliveTimeout=1000;
  await new Promise<void>((resolve,reject)=>{ server.once('error',reject); server.listen(options.port ?? 0,'127.0.0.1',()=>resolve()); });
  const address=server.address(); if(!address || typeof address==='string') throw new Error('Loopback bind unavailable.');
  origin=`http://127.0.0.1:${address.port}`;
  return { origin, launchUrl:hosted ? hosted.origin + '/' : `${origin}/#session=${capability}`, capability, expiresAt:hosted ? null : new Date(expires).toISOString(), close:()=>new Promise<void>((resolve,reject)=>{hosted?.clear();server.close(error=>error?reject(error):resolve());server.closeIdleConnections();}) };
}
