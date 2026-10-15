import { qualifyExistingRoute } from '../src/qualification/existing-routes.js';

const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--out')throw new Error('Usage: node dist/scripts/qualify-adoption-selected-git.js --out NEW_OUTSIDE_REPOSITORY_DIRECTORY');
const report=await qualifyExistingRoute('incremental',args[1],{adoptionBridge:true});
process.stdout.write(JSON.stringify(report,null,2)+'\n');
if(report.status!=='qualified_fixture_lane')process.exitCode=1;
