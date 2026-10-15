import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { startLocalBroker } from '../src/local-broker.js';
import { FixtureIssuer } from '../src/security.js';
import { MODEL, parse, fail } from '../src/model.js';
import { APPLICATION_CHECKER } from '../src/git-application-checker.js';

// Explicit local host configuration, loaded only by the host launching this script.
// Operation packets cannot configure roots, grants, checkers or executables.
const assignment=z.object({principal:z.string().min(1),operations:z.array(z.string()),repositories:z.array(z.string()),git_paths:z.array(z.string()),git_checkers:z.array(z.string().min(1)),layer_ids:z.array(z.string()).nullable().optional(),write_block_ids:z.array(z.string()).nullable().optional(),approvals:z.array(z.string()).optional(),executor:z.string().optional(),reviewers:z.array(z.string()).optional(),expires_at:z.string().datetime().nullable().optional()}).strict();
const schema=z.object({format:z.literal('strata-git-host/1'),project_id:z.string().min(1),state_directory:z.string().min(1),git_directory:z.string().min(1),port:z.number().int().min(1).max(65535),repositories:z.array(z.object({projectId:z.string(),repoId:z.string(),root:z.string()}).strict()).min(1),assignments:z.record(z.string(),assignment),enabled_checkers:z.array(z.literal(APPLICATION_CHECKER))}).strict();
if(process.argv.length!==4||process.argv[2]!=='--file')fail('INVALID_ARGUMENT',2,'Launch with --file OWNER_CONFIG.json.');
const config=parse(schema,JSON.parse(await readFile(process.argv[3],'utf8')));
const issuer=new FixtureIssuer({project_id:config.project_id,assignments:config.assignments});
const broker=await startLocalBroker(config.state_directory,config.port,{model_version:MODEL,issuer,git:{repositories:config.repositories,directory:config.git_directory,enabledCheckers:config.enabled_checkers}});
process.stderr.write(`Strata local Git host at ${broker.url}; trusted local fixture identity only.\n`);
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,async()=>{await broker.close();process.exitCode=0;});
