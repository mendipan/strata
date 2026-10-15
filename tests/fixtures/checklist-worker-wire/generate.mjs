import {writeFile} from 'node:fs/promises';
const version={id:'33333333-3333-4333-8333-333333333333',number:1,created_on:'2026-10-13T02:00:00.000Z',urls:[],
 annotations:{'workers/message':'Synthetic documented version'},source:'api',author_email:'fixture@example.invalid',
 main_module:'app-bundle.mjs',compatibility_date:'2026-10-12',compatibility_flags:['nodejs_compat'],
 limits:{cpu_ms:1000,subrequests:1},bindings:[{type:'version_metadata',name:'CHECKLIST_VERSION'}],
 modules:[{name:'app-bundle.mjs',content_type:'application/javascript+module',content_base64:Buffer.from('export default {};\n// café\n').toString('base64')}]};
const envelope=result=>({success:true,errors:[],messages:[],result});
const files={
 'version.json':envelope(version),
 'deployments.json':envelope({deployments:[{id:'77777777-7777-4777-8777-777777777777',created_on:version.created_on,source:'api',strategy:'percentage',
  annotations:{'workers/triggered_by':'upload'},versions:[{version_id:version.id,percentage:100}]}]}),
 'deployments-active-head.json':envelope({deployments:[
  {id:'77777777-7777-4777-8777-777777777777',created_on:'2026-10-13T02:00:00.000Z',source:'api',strategy:'percentage',
   annotations:{'workers/message':'Synthetic active head with earlier creation clock'},versions:[{version_id:version.id,percentage:100}]},
  {id:'88888888-8888-4888-8888-888888888888',created_on:'2026-10-13T03:00:00.000Z',source:'api',strategy:'percentage',
   annotations:{'workers/message':'Synthetic historical entry with later creation clock'},versions:[{version_id:'44444444-4444-4444-8444-444444444444',percentage:100}]}
 ]}),
 'script-put.json':envelope({id:'synthetic-checklist-app',startup_time_ms:12,etag:'synthetic-opaque-script-hash',has_assets:false})
};
for(const [name,value] of Object.entries(files))await writeFile(new URL(name,import.meta.url),JSON.stringify(value,null,2)+'\n');
