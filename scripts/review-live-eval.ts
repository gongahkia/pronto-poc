import {readFile} from 'node:fs/promises';
import {writeEvalArtifact} from './eval-artifacts';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {boundedLunaCall} from './bounded-luna';
import {LiveEvalBudget} from './live-eval-budget';
import {semanticReviewInstructions,semanticReviewJsonSchema,semanticReviewSchema,semanticReviewData} from '../src/lib/evals/semantic-review';
const arg=(name:string)=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
const reportPath=arg('--report');
if(!reportPath)throw new Error('Use --report <saved report.json>.');
const limit=Number(arg('--limit')??10000);
if(!Number.isSafeInteger(limit)||limit<1)throw new Error('Use a positive review limit.');
const path=resolve(reportPath);
if(!path.startsWith(resolve('output/live-eval')+'/'))throw new Error('Review only local evaluation artifacts.');
const report=JSON.parse(await readFile(path,'utf8'));
if(!report.complete&&!process.argv.includes('--allow-partial'))throw new Error('Review a complete report, or explicitly use --allow-partial for discovery.');
const output=resolve(dirname(path),'semantic-review.json');
const reportHash=createHash('sha256').update(await readFile(path)).digest('hex');
const reviewerHash=createHash('sha256').update(semanticReviewInstructions).digest('hex');
const budget=new LiveEvalBudget(resolve('output/live-eval/budget.json'));
const entries:Record<string,unknown>[]=[];
try{
 const previous=JSON.parse(await readFile(output,'utf8'));
 if(previous.reportHash===reportHash&&previous.reviewerHash===reviewerHash)entries.push(...previous.entries);
 else await writeEvalArtifact(output.replace(/\.json$/,`.${String(previous.reviewerHash).slice(0,12)}.${String(previous.reportHash).slice(0,8)}.json`),JSON.stringify(previous,null,2)+'\n');
}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
const save=async(complete:boolean)=>{
 await writeEvalArtifact(output,JSON.stringify({reportHash,reviewerHash,model:'gpt-6-luna',reviewType:'Independent prompted critic; same model family, not a human or an independent model.',complete,
  reviewedAt:new Date().toISOString(),selection:process.argv.includes('--unique-trials')?'first trial plus all deterministic failures':'all non-skipped turns',entries,budget:await budget.summary()},null,2)+'\n');
};
let newlyReviewed=0;
const firstRounds=new Map<string,number>();
for(const row of report.observations)firstRounds.set(row.caseId,Math.min(firstRounds.get(row.caseId)??Infinity,row.round??1));
const selected=report.observations.filter((row:{caseId:string;round?:number;outcome:string;failures:string[]})=>row.outcome!=='skipped'&&
 (!process.argv.includes('--unique-trials')||(row.round??1)===firstRounds.get(row.caseId)||row.failures.length>0));
try{
 for(const row of selected){
  const key=`${row.caseId}/${row.round??1}/${row.turn}`;
  if(row.outcome==='skipped'||entries.some(entry=>entry.key===key))continue;
  if(newlyReviewed>=limit)break;
  const data=semanticReviewData(row,report.observations);
  const evidenceHash=createHash('sha256').update(JSON.stringify(data)).digest('hex');
  const capture=await boundedLunaCall({budget,instructions:semanticReviewInstructions,data,schema:semanticReviewJsonSchema,name:'pronto_semantic_review'});
  const review=semanticReviewSchema.parse(JSON.parse(capture.outputText));
  entries.push({key,evidenceHash,caseId:row.caseId,turn:row.turn,round:row.round??1,...review,...capture});newlyReviewed++;
  await save(false);console.log(`${review.verdict.toUpperCase()} ${key}: ${review.reason}`);
 }
 const expected=selected.length;
 await save(selected.every((row:{caseId:string;round?:number;turn:number})=>entries.some(entry=>entry.key===`${row.caseId}/${row.round??1}/${row.turn}`)));
 console.log(JSON.stringify({reviewed:entries.length,expected,passes:entries.filter(row=>row.verdict==='pass').length,failures:entries.filter(row=>row.verdict==='fail').length,uncertain:entries.filter(row=>row.verdict==='uncertain').length,budget:await budget.summary()}));
}catch(error){await save(false);throw error;}
