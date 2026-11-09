import {readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {writeEvalArtifact} from './eval-artifacts';
import {renderTranscriptReport} from '../src/lib/evals/report';
import {evaluationScorecard} from '../src/lib/evals/scorecard';
import {summarizeStability} from '../src/lib/evals/plan';
const arg=(key:string)=>{const index=process.argv.indexOf(key);return index<0?undefined:process.argv[index+1];};
const input=arg('--report');if(!input)throw new Error('Use --report <ongoing report.json>.');
const path=resolve(input),round=Number(arg('--round')??1);
if(!path.startsWith(resolve('output/live-eval')+'/'))throw new Error('Snapshot only local evaluation artifacts.');
if(!Number.isInteger(round)||round<1)throw new Error('Use a positive round.');
async function readJson(file:string){for(let attempt=0;attempt<20;attempt++){
 try{return JSON.parse(await readFile(file,'utf8'));}catch(error){if(!(error instanceof SyntaxError))throw error;await new Promise(resolve=>setTimeout(resolve,25));}
}throw new Error('The producer artifact is being written; retry the snapshot.');}
const deadline=Date.now()+40*60_000;
while(true){
 const report=await readJson(path);
 if(report.runStatus==='aborted')throw new Error('The producer aborted; do not treat its partial round as complete.');
 const rows=report.observations.filter((row:{round:number})=>row.round===round);
 const expected=report.expectedTurns/report.rounds;
 if(rows.length!==expected||new Set(rows.map((row:{caseId:string})=>row.caseId)).size!==report.cases){
  if(!process.argv.includes('--wait')||Date.now()>deadline)throw new Error('That round is incomplete.');
  await new Promise(resolve=>setTimeout(resolve,1000));continue;
 }
 const calls=await readJson(resolve(dirname(path),'calls.json'));
 const offset=report.observations.filter((row:{round:number})=>row.round<round).reduce((n:number,row:{modelCalls:number})=>n+row.modelCalls,0);
 const count=rows.reduce((n:number,row:{modelCalls:number})=>n+row.modelCalls,0);
 const captured=calls.slice(offset,offset+count);if(captured.length!==count)throw new Error('Provider captures are incomplete.');
 const turnPlan:Record<string,number>={};for(const row of rows)turnPlan[row.caseId]=Math.max(turnPlan[row.caseId]??0,row.turn);
 const snapshot={...report,runId:`${report.runId}-round-${round}`,rounds:1,observations:rows,expectedTurns:expected,
  completedTurns:rows.length,passedTurns:rows.filter((row:{failures:string[]})=>!row.failures.length).length,complete:true,runStatus:'completed',
  snapshotOf:{runId:report.runId,path,round,observationsHash:createHash('sha256').update(JSON.stringify(rows)).digest('hex')},
  scorecard:evaluationScorecard(rows,expected),stability:summarizeStability(rows,{turns:turnPlan,rounds:1})};
 const output=resolve(dirname(path),`round-${round}`);
 await writeEvalArtifact(resolve(output,'report.json'),JSON.stringify(snapshot,null,2)+'\n');
 await writeEvalArtifact(resolve(output,'calls.json'),JSON.stringify(captured,null,2)+'\n');
 await writeEvalArtifact(resolve(output,'report.html'),renderTranscriptReport(snapshot));
 console.log(JSON.stringify({path:resolve(output,'report.json'),turns:rows.length,modelCalls:count}));break;
}
