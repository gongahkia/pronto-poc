import {readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {liveCustomerCases,liveHoldoutCases,chopeEvaluationCases,chopeWebsiteCases,type LiveCase} from '../evals/live-customer-cases';
import {hardeningCases,hardeningChallengeCases} from '../evals/hardening-cases';
import {gradeLiveTurn,type LiveObservation} from '../src/lib/evals/live-quality';
import {summarizeStability} from '../src/lib/evals/plan';
import {evaluationScorecard,type GradedTurn} from '../src/lib/evals/scorecard';
import {renderTranscriptReport} from '../src/lib/evals/report';
import {writeEvalArtifact} from './eval-artifacts';
const arg=(key:string)=>{const index=process.argv.indexOf(key);return index<0?undefined:process.argv[index+1];};
const input=arg('--report'),reason=arg('--reason');
if(!input||!reason)throw new Error('Use --report <report.json> and an explicit --reason for the grading correction.');
const path=resolve(input);
if(!path.startsWith(resolve('output/live-eval')+'/'))throw new Error('Only local evaluation artifacts can be regraded.');
const raw=await readFile(path,'utf8'),report=JSON.parse(raw);
if(!report.complete)throw new Error('Wait for a complete run; partial runs must remain visibly incomplete.');
const runtimeDrift:string[]=[];
for(const [file,hash]of Object.entries(report.sourceHashes??{})){
 if(file.startsWith('src/')&&!file.startsWith('src/lib/evals/')&&createHash('sha256').update(await readFile(file)).digest('hex')!==hash)
  runtimeDrift.push(file);
}
if(runtimeDrift.length&&!process.argv.includes('--historical'))throw new Error('Runtime changed since generation. Use --historical only to review old outputs; run genuine inference again for current-runtime acceptance.');
const cases=new Map<string,LiveCase>([...liveCustomerCases,...liveHoldoutCases,...chopeEvaluationCases,...chopeWebsiteCases,...hardeningCases,...hardeningChallengeCases].map(item=>[item.id,item]));
const changes=[];
for(const row of report.observations){
 const item=cases.get(row.caseId),expected=item?.turns[row.turn-1]?.expect;
 if(!item||!expected)throw new Error(`The case definition is missing: ${row.caseId}`);
 const failures=gradeLiveTurn(expected,row as LiveObservation);
 if(item.probe&&!row.probePassed)failures.push('The idempotency probe failed.');
 const canaries={'unapproved-price':'UNPUBLISHED_CANARY','archived-price':'ARCHIVED_CANARY','foreign-tenant':'FOREIGN_TENANT_CANARY','conflicted-price':'CONFLICT_CANARY'};
 if(item.sourceFixture&&String(row.packedContext??'').includes(canaries[item.sourceFixture]))failures.push('Withheld or foreign knowledge reached the model context.');
 if(JSON.stringify(row.expected)!==JSON.stringify(expected)||JSON.stringify(row.failures)!==JSON.stringify(failures))
  changes.push({caseId:row.caseId,round:row.round??1,turn:row.turn,oldExpected:row.expected,newExpected:expected,oldFailures:row.failures,newFailures:failures});
 row.expected=expected;row.failures=failures;row.evaluationFixture=item.fixture??item.sourceFixture??null;
}
const gradingFiles=['src/lib/evals/live-quality.ts','evals/live-customer-cases.ts','evals/hardening-cases.ts','src/lib/evals/plan.ts','src/lib/evals/scorecard.ts'];
report.gradingReview={reason,reviewedAt:new Date().toISOString(),originalReport:path,originalReportHash:createHash('sha256').update(raw).digest('hex'),changes,
 runtimeMatchesCurrent:runtimeDrift.length===0,changedRuntimeFiles:runtimeDrift,
 sourceHashes:Object.fromEntries(await Promise.all(gradingFiles.map(async file=>[file,createHash('sha256').update(await readFile(file)).digest('hex')])))};
report.passedTurns=report.observations.filter((row:{failures:string[]})=>!row.failures.length).length;
report.scorecard=evaluationScorecard(report.observations as GradedTurn[],report.expectedTurns??report.completedTurns);
const ids=new Set<string>(report.observations.map((row:{caseId:string})=>row.caseId));
report.stability=summarizeStability(report.observations,{rounds:report.rounds??1,turns:Object.fromEntries([...ids].map(id=>[id,cases.get(id)!.turns.length]))});
const target=resolve(dirname(path),'report.regraded.json');
await writeEvalArtifact(target,JSON.stringify(report,null,2)+'\n');
await writeEvalArtifact(target.replace(/\.json$/,'.html'),renderTranscriptReport(report));
console.log(JSON.stringify({target,changedTurns:changes.length,passedTurns:report.passedTurns,total:report.completedTurns,criticalFailures:report.scorecard.criticalFailures.length}));
