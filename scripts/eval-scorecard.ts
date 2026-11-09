import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname,relative} from 'node:path';
import {liveCustomerCases,liveHoldoutCases,chopeEvaluationCases,chopeWebsiteCases} from '../evals/live-customer-cases';
import {hardeningCases,hardeningChallengeCases} from '../evals/hardening-cases';
import {assessAcceptance,runtimeFingerprint,type EvidenceReport,type ProviderCapture} from '../src/lib/evals/acceptance';
import {semanticReviewData,semanticReviewInstructions} from '../src/lib/evals/semantic-review';
import {escapeReport,renderTranscriptReport} from '../src/lib/evals/report';
import {LiveEvalBudget} from './live-eval-budget';
import {writeEvalArtifact} from './eval-artifacts';

const arg=(key:string)=>{const index=process.argv.indexOf(key);return index<0?undefined:process.argv[index+1];};
const local=(path:string)=>{const result=resolve(path);if(!result.startsWith(resolve('output/live-eval')+'/'))throw new Error('Use local output/live-eval artifacts only.');return result;};
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const load=async<T>(path:string):Promise<T>=>JSON.parse(await readFile(path,'utf8'));
const paths=Object.fromEntries(['candidate','website','stress','critic','website-critic','stress-critic','calibration','mutations','audit'].map(name=>{const path=arg(`--${name}`);if(!path)throw new Error(`Missing --${name} <report.json>`);return [name,local(path)];}));
const candidate=await load<EvidenceReport>(paths.candidate),website=await load<EvidenceReport>(paths.website),stress=await load<EvidenceReport>(paths.stress);
const hashes=Object.fromEntries(await Promise.all([paths.candidate,paths.website].map(async path=>[path,hash(await readFile(path,'utf8'))])));
const controlled=[...liveCustomerCases,...liveHoldoutCases,...chopeEvaluationCases,...hardeningCases,...hardeningChallengeCases];
const captures=Object.fromEntries(await Promise.all(['candidate','website','stress'].map(async name=>[name,await load<ProviderCapture[]>(resolve(dirname(paths[name]),'calls.json'))]))) as Record<'candidate'|'website'|'stress',ProviderCapture[]>;
const acceptance=assessAcceptance({candidate,website,stress,controlledCases:controlled,websiteCases:chopeWebsiteCases,captures});
const failures=[...acceptance.failures];
for(const [file,generatedHash]of Object.entries(runtimeFingerprint(candidate)))if(hash(await readFile(file,'utf8'))!==generatedHash)failures.push(`Candidate runtime changed: ${file}`);
for(const file of ['src/lib/evals/live-quality.ts','src/lib/evals/plan.ts','src/lib/evals/scorecard.ts','evals/live-customer-cases.ts','evals/hardening-cases.ts']){
 const currentHash=hash(await readFile(file,'utf8'));
 if([candidate,website,stress].some(report=>(report.gradingReview?.runtimeMatchesCurrent?report.gradingReview.sourceHashes:report.sourceHashes)[file]!==currentHash))failures.push(`Corpus or grading implementation differs from current acceptance evidence: ${file}`);
}
for(const report of [candidate,website,stress])if(report.gradingReview){
 const review=report.gradingReview;
 if(!review.runtimeMatchesCurrent||hash(await readFile(local(review.originalReport),'utf8'))!==review.originalReportHash)
  failures.push(`Grading correction lacks unchanged-runtime original evidence: ${report.runId}`);
}
type ReviewEntry={key:string;evidenceHash:string;verdict:string;reason:string;};
type Critic={reportHash:string;reviewerHash:string;complete:boolean;entries:ReviewEntry[]};
const critics=await Promise.all(['critic','website-critic','stress-critic'].map(name=>load<Critic>(paths[name])));
const calibration=await load<{reviewerHash:string;results:{id:string;matched:boolean}[]}>(paths.calibration);
const reviewerHash=hash(semanticReviewInstructions);
if(calibration.reviewerHash!==reviewerHash||calibration.results.length<28||calibration.results.some(row=>!row.matched))failures.push('Reviewer calibration is incomplete or mismatched');
type Adjudication={key:string;evidenceHash:string;disposition:'false-positive'|'confirmed';reason:string;};
const adjudications:Adjudication[]=arg('--adjudications')?await load(local(arg('--adjudications')!)):[];
const reviewFlags=[];
let reviewed=0;
for(const [index,report]of [candidate,website,stress].entries()){
 const critic=critics[index],reportPath=[paths.candidate,paths.website,paths.stress][index];
 if(critic.reportHash!==hash(await readFile(reportPath,'utf8'))||critic.reviewerHash!==reviewerHash||!critic.complete)failures.push(`Semantic review is incomplete or mismatched: ${report.runId}`);
 reviewed+=critic.entries.length;
 for(const row of report.observations.filter(row=>row.outcome!=='skipped')){
 const key=`${row.caseId}/${row.round??1}/${row.turn}`,entry=critic.entries.find(entry=>entry.key===key);
 const evidenceHash=hash(JSON.stringify(semanticReviewData(row,report.observations)));
 if(!entry||entry.evidenceHash!==evidenceHash){failures.push(`Missing/mismatched semantic review: ${key}`);continue;}
 if(entry.verdict!=='pass'){
  const adjudication=adjudications.find(item=>item.key===key&&item.evidenceHash===evidenceHash&&item.reason.trim().length>=20);
  reviewFlags.push({runId:report.runId,...entry,adjudication:adjudication??null});
  if(adjudication?.disposition!=='false-positive')failures.push(`Unresolved semantic review: ${key}`);
 }
}
}
const budget=await new LiveEvalBudget(resolve('output/live-eval/budget.json')).summary();
if(budget.accountedUsd>budget.limitUsd)failures.push('Cumulative budget exceeded');
const mutations=await load<{complete:boolean;total:number;detected:number;reportHashes:{hash:string}[];gradingHash:string;operators:unknown[]}>(paths.mutations);
if(!mutations.complete||mutations.total<1000||mutations.total!==mutations.detected||mutations.gradingHash!==hash(await readFile('src/lib/evals/live-quality.ts','utf8'))||
 ![paths.candidate,paths.website].every(path=>mutations.reportHashes.some(entry=>entry.hash===hashes[path])))failures.push('Negative controls are incomplete, missed a corruption, or belong to different acceptance evidence');
const diagnosticPath=arg('--diagnostic'),diagnostic=diagnosticPath?await load<EvidenceReport>(local(diagnosticPath)):null;
const priorPath=arg('--previous-candidate'),priorCandidate=priorPath?await load<EvidenceReport>(local(priorPath)):null;
const historicalSummary=(report:EvidenceReport|null)=>report?{runId:report.runId,turns:report.observations.length,
 passed:report.observations.filter(row=>!row.failures.length).length,rounds:report.rounds,
 failures:report.observations.filter(row=>row.failures.length).map(row=>({caseId:row.caseId,round:row.round,turn:row.turn,failures:row.failures})),
 runtimeMatchesCandidate:JSON.stringify(runtimeFingerprint(report))===JSON.stringify(runtimeFingerprint(candidate))}:null;
const audit=await load<{complete:boolean;passed:boolean;reportHashes:{hash:string}[];turns:number;verifiedReplies:number;verifiedSilentTurns:number;failures:string[]}>(paths.audit);
if(!audit.complete||!audit.passed||audit.failures.length||audit.turns!==candidate.observations.length+website.observations.length+stress.observations.length||
 !(await Promise.all([paths.candidate,paths.website,paths.stress].map(async path=>{const actualHash=hash(await readFile(path,'utf8'));return audit.reportHashes.some(entry=>entry.hash===actualHash);}))).every(Boolean))
 failures.push('Exact-generation delivery audit is missing, failed or mismatched');
const rows=[...candidate.observations,...website.observations];
const latencies=rows.filter(row=>row.outcome!=='skipped').map(row=>row.latencyMs??0).sort((a,b)=>a-b);
const percentile=(fraction:number)=>latencies[Math.max(0,Math.ceil(latencies.length*fraction)-1)]??null;
const performance={scope:'Sequential local fixture turns; this is not a production load test.',measuredTurns:latencies.length,
 p50Ms:percentile(0.5),p95Ms:percentile(0.95),maximumMs:latencies.at(-1)??null,
 modelCalls:rows.reduce((n,row)=>n+row.modelCalls,0),scopedWebsiteReads:website.observations.reduce((n,row)=>n+(row.toolReads??0),0)};
const summary={generatedAt:new Date().toISOString(),...acceptance,automatedAcceptance:failures.length?'fail':'pass',failures,gate:failures.length?'fail':'pass',
 budget,paths,performance,gradingCorrections:[candidate,website,stress].filter(report=>report.gradingReview).map(report=>({runId:report.runId,reason:report.gradingReview!.reason,
  originalReport:report.gradingReview!.originalReport,originalReportHash:report.gradingReview!.originalReportHash,runtimeMatchesCurrent:report.gradingReview!.runtimeMatchesCurrent,changedGradedTurns:report.gradingReview!.changes.length})),
 deliveryAudit:{turns:audit.turns,verifiedReplies:audit.verifiedReplies,verifiedSilentTurns:audit.verifiedSilentTurns,passed:audit.passed},sourceHashes:candidate.sourceHashes,fixtureState:candidate.fixtureState,
 negativeControls:{total:mutations.total,detected:mutations.detected,operators:mutations.operators},
 critic:{reviewed,flags:reviewFlags,calibrationMatched:calibration.results.filter(row=>row.matched).length,calibrationTotal:calibration.results.length,
  limitation:'The critic uses a separate prompt with the same Luna model family; calibration and a model pass are not independent human verification.'},
 diagnostic:historicalSummary(diagnostic),previousCandidate:historicalSummary(priorCandidate),
 deploymentDecision:'Not deployed. Require genuine Groq acceptance and target channel verification before deployment. Synthetic scenarios do not establish production reliability, ROI, native-language quality or exhaustive security coverage.'};
const output=local(arg('--output')??'output/live-eval/hardening-review.html');
const base=output.replace(/\.html$/, '');
await writeEvalArtifact(`${base}.json`,JSON.stringify(summary,null,2)+'\n');
const csv=(value:unknown)=>`"${String(value??'').replace(/"/g,'""')}"`;
await writeEvalArtifact(`${base}.csv`,[['case','category','round','turn','customer','reply','outcome','checks'].map(csv).join(','),...rows.map(row=>[row.caseId,row.category,row.round??1,row.turn,row.customer,row.answer,row.outcome,row.failures.join(' | ')].map(csv).join(','))].join('\n')+'\n');
const e=escapeReport;
const link=(path:string,title:string)=>`<a href="${e(relative(dirname(output),path).split('/').map(encodeURIComponent).join('/'))}">${e(title)}</a>`;
const intro=`<h1>200-scenario product hardening</h1><p><b>Automated acceptance: ${e(summary.automatedAcceptance)}.</b> ${acceptance.uniqueScenarios} distinct scenarios, ${rows.length} acceptance turns. Cumulative conservative accounting: US$${budget.accountedUsd.toFixed(4)} / US$${budget.limitUsd}.</p><p>Current candidate, real Chope website reads and stress trials must share runtime, knowledge and configuration hashes. Diagnostic runs retain their original versions and failures.</p><ul>${Object.entries(paths).map(([name,path])=>`<li>${link(path,name)}</li>`).join('')}</ul><h2>Product quality</h2><pre>${e(JSON.stringify(acceptance.scorecard,null,2))}</pre><h2>Repeatability</h2><p>${acceptance.stressStability.filter(row=>row.stable).length}/${acceptance.stressStability.length} selected cases passed every stress trial.</p><pre>${e(JSON.stringify(acceptance.stressStability,null,2))}</pre><h2>Semantic review and calibration</h2><pre>${e(JSON.stringify(summary.critic,null,2))}</pre><h2>Negative controls</h2><pre>${e(JSON.stringify(summary.negativeControls,null,2))}</pre><h2>Observed local latency</h2><pre>${e(JSON.stringify(performance,null,2))}</pre><h2>Earlier diagnostic evidence</h2><pre>${e(JSON.stringify(summary.diagnostic,null,2))}</pre><h2>Remaining limits</h2><p>${e(summary.deploymentDecision)}</p>${failures.length?`<pre class="fail">${e(failures.join('\n'))}</pre>`:''}<hr>`;
const transcript=renderTranscriptReport({runId:'Current acceptance transcripts',observations:rows,passedTurns:rows.filter(row=>!row.failures.length).length,completedTurns:rows.length,
 complete:acceptance.scorecard.complete,rounds:1,budget});
const earlierCandidate=summary.previousCandidate?`<h2>Prior candidate failure</h2><pre>${e(JSON.stringify(summary.previousCandidate,null,2))}</pre>`:'';
const deliveryEvidence=`<h2>Audited grading corrections</h2><pre>${e(JSON.stringify(summary.gradingCorrections,null,2))}</pre><h2>Exact-generation delivery audit</h2><pre>${e(JSON.stringify(summary.deliveryAudit,null,2))}</pre>`;
await writeEvalArtifact(output,transcript.replace('<h1>Pronto · evaluation transcripts</h1>',intro+earlierCandidate+deliveryEvidence+'<h1>Acceptance transcripts</h1>'));
console.log(JSON.stringify({output,gate:summary.automatedAcceptance,scenarios:acceptance.uniqueScenarios,turns:rows.length,failures,budget}));
if(failures.length)process.exitCode=1;
