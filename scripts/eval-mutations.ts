import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {gradeLiveTurn,type LiveObservation} from '../src/lib/evals/live-quality';
import {testNegativeControls} from '../src/lib/evals/mutations';
import type {LiveExpectation} from '../evals/live-customer-cases';
import {writeEvalArtifact} from './eval-artifacts';
const arg=(key:string)=>{const index=process.argv.indexOf(key);return index<0?undefined:process.argv[index+1];};
const reports=arg('--reports')?.split(',');if(!reports?.length)throw new Error('Use --reports <candidate.json>,<website.json>. This command makes no API calls.');
const results:{caseId:string;round:number;turn:number;name:string;detected:boolean}[]=[],reportHashes:{path:string;hash:string}[]=[];
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
for(const input of reports){
 const path=resolve(input);if(!path.startsWith(resolve('output/live-eval')+'/'))throw new Error('Use local evaluation artifacts.');
 const raw=await readFile(path,'utf8'),report=JSON.parse(raw);
 if(!report.complete||report.runStatus!=='completed')throw new Error('Negative controls require complete acceptance reports.');
 reportHashes.push({path,hash:hash(raw)});
 for(const row of report.observations as (LiveObservation&{caseId:string;round?:number;turn:number;expected:LiveExpectation;failures:string[]})[]){
  if(row.failures.length||gradeLiveTurn(row.expected,row).length)throw new Error(`Original observation already fails: ${row.caseId}. Fix or investigate it first.`);
  for(const result of testNegativeControls(row.expected,row))results.push({caseId:row.caseId,round:row.round??1,turn:row.turn,...result});
 }
}
const names=[...new Set(results.map(row=>row.name))];
const summary={complete:true,kind:'Offline negative controls; these are corrupted saved observations, not model-generated conversations.',reportHashes,
 gradingHash:hash(await readFile('src/lib/evals/live-quality.ts','utf8')),mutationHash:hash(await readFile('src/lib/evals/mutations.ts','utf8')),
 total:results.length,detected:results.filter(row=>row.detected).length,
 operators:names.map(name=>({name,total:results.filter(row=>row.name===name).length,detected:results.filter(row=>row.name===name&&row.detected).length})),
 missed:results.filter(row=>!row.detected)};
const output=resolve(arg('--output')??'output/live-eval/hardening-negative-controls.json');
if(!output.startsWith(resolve('output/live-eval')+'/'))throw new Error('Write only local evaluation artifacts.');
await writeEvalArtifact(output,JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify({output,...summary}));
if(summary.missed.length)process.exitCode=1;
