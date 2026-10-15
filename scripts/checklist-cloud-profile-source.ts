import {readFile} from 'node:fs/promises';
import path from 'node:path';
import type {Plugin} from 'esbuild';
import {parse as parseJavaScript} from '@babel/parser';
import {canonical,digest,fail} from '../src/model.js';
import {profileArchive,profileFor} from '../src/profile.js';

// Preserve the Node archive's source TEXT, not the bundler's Function.toString() formatting.
// Only these collection archive/digest extraction sites are replaced with captured literals.
// Recognizers, reconstruction, checkers and their verification gates remain ordinary compiled code.
const sites={
  'collection-semantics.js':{collectionCountRequirement:['base.semantics.sources.count',1],collectionTitleRequirement:['base.semantics.sources.title',1],
    criterion:['base.semantics.sources.criterion',1],entry:['base.semantics.sources.entry',1],expectedBlocks:['base.semantics.sources.blocks',1],
    recognizeCollection:['base.semantics.sources.recognition',1],recognizeCollectionEvaluation:['base.semantics.sources.obligations',1],collectionOracle:['base.semantics.sources.oracle',1]},
  'collection-checker.js':{collectionCheckSuite:['base.checker.source',2]},
  'collection-host-semantics.js':{collectionAuditRelationship:['semantics.sources.relationship',1],collectionAuditOutput:['semantics.sources.output',1],
    collectionAuditCriterion:['semantics.sources.criterion',1],collectionAuditBlock:['semantics.sources.audit',1],semanticBlock:['semantics.sources.projection',1],
    recognizeHostCollection:['semantics.sources.recognition',1],recognizeHostCollectionEvaluation:['semantics.sources.conservation',1],hostCollectionOracle:['semantics.sources.oracle',1]},
  'collection-host-checker.js':{hostCollectionCheckSuite:['checker.source',2]},
  'collection-host.js':{hostCollectionProgram:['program',1]}
} as const;
function sourceAt(archive:unknown,key:string):string{
  let value=archive;for(const segment of key.split('.'))value=(value as Record<string,unknown>)?.[segment];
  if(typeof value!=='string'||!value||value.length>32768)fail('CHECKLIST_PROFILE_SOURCE_REFUSED',6,'Exact bounded Node collection archive source required.');
  return value as string;
}
type Syntax={type:string;start?:number|null;end?:number|null;[field:string]:unknown};
const syntax=(value:unknown):value is Syntax=>!!value&&typeof value==='object'&&typeof (value as Syntax).type==='string';
const identifier=(value:unknown)=>syntax(value)&&value.type==='Identifier'?String(value.name):null;
const refused=():never=>fail('CHECKLIST_PROFILE_SOURCE_REFUSED',6,'Node source text or exact archive extraction sites changed.');
function preserveSources(contents:string,mapping:Record<string,readonly [string,number]>,archive:unknown){
  let program:Syntax;try{program=parseJavaScript(contents,{sourceType:'module',attachComment:false}).program as unknown as Syntax;}catch{return refused();}
  const names=new Set(Object.keys(mapping)),bindings=new Map<string,number>(),functions=new Map<string,Syntax>(),calls=new Map<string,Syntax[]>(),writes=new Set<string>();
  const bind=(pattern:unknown):void=>{
    if(!syntax(pattern))return;
    const name=identifier(pattern);if(name){if(names.has(name))bindings.set(name,(bindings.get(name)??0)+1);return;}
    if(pattern.type==='ObjectPattern')for(const p of pattern.properties as Syntax[])bind(p.type==='RestElement'?p.argument:p.value);
    else if(pattern.type==='ArrayPattern')for(const element of pattern.elements as unknown[])bind(element);
    else if(pattern.type==='RestElement')bind(pattern.argument);
    else if(pattern.type==='AssignmentPattern')bind(pattern.left);
  };
  // Only actual module-level named function declarations or const function initializers qualify.
  for(const raw of program.body as Syntax[]){
    const statement=raw.type==='ExportNamedDeclaration'?raw.declaration:raw;if(!syntax(statement))continue;
    if(statement.type==='FunctionDeclaration'){
      const name=identifier(statement.id);if(name&&names.has(name)){if(functions.has(name))refused();functions.set(name,statement);}
    }else if(statement.type==='VariableDeclaration'&&statement.kind==='const')for(const declaration of statement.declarations as Syntax[]){
      const name=identifier(declaration.id),value=declaration.init;
      if(name&&names.has(name)&&syntax(value)&&['FunctionExpression','ArrowFunctionExpression'].includes(value.type)){
        if(functions.has(name))refused();functions.set(name,value);
      }
    }
  }
  const written=(target:unknown):void=>{
    if(!syntax(target))return;
    const name=identifier(target);if(name){if(names.has(name))writes.add(name);return;}
    if(target.type==='MemberExpression'||target.type==='OptionalMemberExpression')written(target.object);
    else if(target.type==='ObjectPattern')for(const p of target.properties as Syntax[])written(p.type==='RestElement'?p.argument:p.value);
    else if(target.type==='ArrayPattern')for(const element of target.elements as unknown[])written(element);
    else if(target.type==='RestElement')written(target.argument);
    else if(target.type==='AssignmentPattern')written(target.left);
  };
  const walk=(node:Syntax,parent?:Syntax):void=>{
    if(node.type==='VariableDeclarator')bind(node.id);
    if(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression','ObjectMethod','ClassMethod','ClassPrivateMethod'].includes(node.type)){
      if(node.type==='FunctionDeclaration'||node.type==='FunctionExpression')bind(node.id);
      for(const parameter of node.params as unknown[])bind(parameter);
    }
    if(['ClassDeclaration','ClassExpression'].includes(node.type))bind(node.id);
    if(['ImportSpecifier','ImportDefaultSpecifier','ImportNamespaceSpecifier'].includes(node.type))bind(node.local);
    if(node.type==='CatchClause')bind(node.param);
    if(node.type==='AssignmentExpression')written(node.left);
    if(node.type==='UpdateExpression')written(node.argument);
    if(['ForInStatement','ForOfStatement'].includes(node.type)&&syntax(node.left)&&node.left.type!=='VariableDeclaration')written(node.left);
    if(['MemberExpression','OptionalMemberExpression'].includes(node.type)){
      const name=identifier(node.object),property=node.property;
      const toString=syntax(property)&&((property.type==='Identifier'&&property.name==='toString')||(property.type==='StringLiteral'&&property.value==='toString'));
      if(name&&names.has(name)&&toString){
        if(node.type!=='MemberExpression'||node.computed||!parent||parent.type!=='CallExpression'||parent.callee!==node||
          !Array.isArray(parent.arguments)||parent.arguments.length!==0||parent.optional)refused();
        calls.set(name,[...(calls.get(name)??[]),parent!]);
      }
    }
    // Parser comments, source strings and template text are data, never declaration/call syntax.
    for(const [key,value]of Object.entries(node)){
      if(['comments','leadingComments','trailingComments','innerComments','tokens','extra','loc'].includes(key))continue;
      if(Array.isArray(value)){for(const child of value)if(syntax(child))walk(child,node);}else if(syntax(value))walk(value,node);
    }
  };
  walk(program);
  const replacements:{start:number;end:number;text:string}[]=[];
  for(const [name,[key,count]]of Object.entries(mapping)){
    const source=sourceAt(archive,key),actual=functions.get(name),extractions=calls.get(name)??[];
    if(!actual||bindings.get(name)!==1||writes.has(name)||!Number.isInteger(actual.start)||!Number.isInteger(actual.end)||
      contents.slice(actual.start!,actual.end!)!==source||extractions.length!==count)refused();
    for(const call of extractions){if(!Number.isInteger(call.start)||!Number.isInteger(call.end))refused();replacements.push({start:call.start!,end:call.end!,text:JSON.stringify(source)});}
  }
  // Original parser spans stay valid: replace executable calls from the end of the module backward.
  for(const r of replacements.sort((a,b)=>b.start-a.start))contents=contents.slice(0,r.start)+r.text+contents.slice(r.end);
  return contents;
}
export function checklistProfileSource(repository:string){
  const archive=profileArchive('collection-host/1'),checker_sha256=profileFor('collection-host/1').checker.digest();
  const identity={format:'strata-checklist-profile-source/1',profile_id:'collection-host/1',profile_sha256:digest(archive),checker_sha256,archive};
  const loaded=new Set<string>();
  const plugin:Plugin={name:'checklist-node-profile-source',setup(build){
    build.onLoad({filter:/[\\/]dist[\\/]src[\\/]profiles[\\/]collection(?:-host)?(?:-semantics|-checker)?\.js$/},async ({path:file})=>{
      const name=path.basename(file),mapping=sites[name as keyof typeof sites];if(!mapping)return;
      if(path.resolve(file)!==path.resolve(repository,'dist/src/profiles',name))fail('CHECKLIST_PROFILE_SOURCE_REFUSED',6,'Only the exact reviewed compiled collection source is admitted.');
      const contents=preserveSources(await readFile(file,'utf8'),mapping,archive);
      loaded.add(name);return{contents,loader:'js'};
    });
    build.onEnd(result=>{if(!result.errors.length&&canonical([...loaded].sort())!==canonical(Object.keys(sites).sort()))fail('CHECKLIST_PROFILE_SOURCE_REFUSED',6,'Every collection source extraction module must be preserved.');});
  }};
  return{identity,plugin};
}
