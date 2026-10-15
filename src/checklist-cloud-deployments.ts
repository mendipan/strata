import {fail} from './model.js';

const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
export type ChecklistDeployment={id:string;created_on:string;source:string;strategy:'percentage';versions:{version_id:string;percentage:number}[]};
function refused():never{return fail('CHECKLIST_DEPLOYMENT_REFUSED',7,'Documented deployment list and unambiguous exact single version at 100% required.');}
// DeploymentListResponse is an object containing deployments, never a bare array.
// Deployment.id and versions[].version_id have distinct meanings.
export function checklistLatestDeployment(raw:unknown,fresh=false):ChecklistDeployment {
 if(!object(raw)||['pagination','cursor','next_cursor','has_more','result_info'].some(k=>Object.hasOwn(raw,k))||
  !Array.isArray(raw.deployments)||!raw.deployments.length||raw.deployments.length>(fresh?1:100))refused();
 const deployments:ChecklistDeployment[]=raw.deployments.map(d=>{
  if(!object(d)||typeof d.id!=='string'||!d.id||typeof d.created_on!=='string'||!Number.isFinite(Date.parse(d.created_on))||
   typeof d.source!=='string'||!d.source||d.strategy!=='percentage'||!Array.isArray(d.versions)||d.versions.length!==1)refused();
  const version=d.versions[0];if(!object(version)||!uuid(version.version_id)||version.percentage!==100)refused();
  return{id:d.id,created_on:d.created_on,source:d.source,strategy:'percentage',versions:[{version_id:version.version_id,percentage:100}]};
 });
 if(new Set(deployments.map(d=>d.id)).size!==deployments.length)refused();
 // The API identifies the first returned deployment as actively serving traffic.
 // Creation clocks are metadata, never authority to reorder or replace that head.
 return deployments[0];
}
