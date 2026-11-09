import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {liveCustomerCases,liveHoldoutCases,chopeEvaluationCases,chopeWebsiteCases,type LiveExpectation} from '../evals/live-customer-cases';
import {hardeningCases,hardeningChallengeCases} from '../evals/hardening-cases';
import {gradeLiveTurn,type LiveObservation} from '../src/lib/evals/live-quality';
import {writeEvalArtifact} from './eval-artifacts';
const index=process.argv.indexOf('--reports'),inputs=index<0?[]:process.argv[index+1].split(',');
if(!inputs.length)throw new Error('Use --reports <saved.json>,<optional-later-focused-run.json>. No model calls are made.');
type Row=LiveObservation&{caseId:string;turn:number;customer:string};
const latest=new Map<string,{row:Row;source:string}>(),sources=[];
for(const input of inputs){
 const path=resolve(input);if(!path.startsWith(resolve('output/live-eval')+'/'))throw new Error('Use saved local evaluation reports.');
 const raw=await readFile(path,'utf8'),report=JSON.parse(raw);if(!report.complete)throw new Error('Use complete reports.');
 sources.push({path,sha256:createHash('sha256').update(raw).digest('hex')});
 for(const row of report.observations as Row[])latest.set(`${row.caseId}/${row.turn}`,{row,source:path});
}
const cases=new Map([...liveCustomerCases,...liveHoldoutCases,...chopeEvaluationCases,...chopeWebsiteCases,...hardeningCases,...hardeningChallengeCases].map(item=>[item.id,item]));
const labels={english:'English',chinese:'Chinese / Mandarin',malay:'Bahasa Melayu',tamil:'Tamil'};
const results=[],mixedInputCases:string[]=[];let correctSilences=0;
for(const {row,source}of latest.values()){
 if(row.outcome==='skipped'){correctSilences++;continue;}
 const explicit=cases.get(row.caseId)?.turns[row.turn-1]?.expect.language;
 if(!explicit&&/[\u3400-\u9fff\u0b80-\u0bff]/.test(row.customer)){mixedInputCases.push(row.caseId);continue;}
 const language=explicit??'english';
 const failures=gradeLiveTurn({outcome:row.outcome as LiveExpectation['outcome'],language,minCitations:0},row).filter(message=>/language/.test(message));
 results.push({caseId:row.caseId,turn:row.turn,language,source,passed:failures.length===0,failures});
}
const summary={kind:'Free language audit of saved replies; later report replaces an earlier case/turn. This is not a fresh full-model acceptance run.',sources,
 supportedLanguages:labels,coverage:Object.entries(labels).map(([key,name])=>({language:key,name,replyTurns:results.filter(row=>row.language===key).length,
  passed:results.filter(row=>row.language===key&&row.passed).length})),correctSilences,mixedInputCases,failures:results.filter(row=>!row.passed),results,
 limitation:'Script and keyword checks detect obvious language mismatches; they do not establish native-speaker fluency or equal coverage of every intent in each language. The Malay refund example includes the English phrase Our team.'};
await writeEvalArtifact(resolve('output/live-eval/language-review.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({coverage:summary.coverage,correctSilences,mixedInputCases,failures:summary.failures}));
if(summary.coverage.some(row=>!row.replyTurns)||summary.failures.length)process.exitCode=1;
