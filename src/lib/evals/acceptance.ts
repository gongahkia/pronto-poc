import {evaluationScorecard,type GradedTurn} from './scorecard';
import {summarizeStability} from './plan';

export type EvidenceTurn=GradedTurn&{customer:string;conversationId?:string;latencyMs?:number;};
export type EvidenceReport={runId:string;complete:boolean;runStatus:string;rounds:number;cases:number;expectedTurns:number;
 observations:EvidenceTurn[];sourceHashes:Record<string,string>;fixtureState:{knowledgeHash:string;configurationHash:string};
 provider:string;model:string;reasoningEffort:string;
 gradingReview?:{reason:string;originalReport:string;originalReportHash:string;runtimeMatchesCurrent:boolean;sourceHashes:Record<string,string>;changes:unknown[]};};
export type ProviderCapture={status:number;responseId?:string;model?:string;usage?:unknown};
type PlannedCase={id:string;turns:unknown[]};

export function runtimeFingerprint(report:EvidenceReport){
 return Object.fromEntries(Object.entries(report.sourceHashes).filter(([file])=>file.startsWith('src/')&&!file.startsWith('src/lib/evals/')).sort(([a],[b])=>a.localeCompare(b)));
}

// A green partial run, omitted difficult case or incompatible runtime must never
// become acceptance evidence merely by combining its aggregate pass counts.
export function assessAcceptance(input:{candidate:EvidenceReport;website:EvidenceReport;stress:EvidenceReport;
 controlledCases:PlannedCase[];websiteCases:PlannedCase[];captures:Record<'candidate'|'website'|'stress',ProviderCapture[]>}){
 const failures:string[]=[];
 const plans={candidate:input.controlledCases,website:input.websiteCases,
  stress:input.controlledCases.filter(item=>input.stress.observations.some(row=>row.caseId===item.id))};
 for(const name of ['candidate','website','stress'] as const){
  const report=input[name],plan=plans[name];
  if(!report.complete||report.runStatus!=='completed')failures.push(`${name}: incomplete or interrupted run`);
  if(report.provider!=='openai'||report.model!=='gpt-6-luna'||report.reasoningEffort!=='low')failures.push(`${name}: unexpected inference configuration`);
  const rounds=name==='stress'?report.rounds:1;
  if(name==='stress'&&(rounds<3||plan.length<12))failures.push('stress: require at least 12 cases and three complete trials');
  if(report.rounds!==rounds||report.cases!==plan.length)failures.push(`${name}: case/round manifest mismatch`);
  const expected=new Set<string>();
  for(let round=1;round<=rounds;round++)for(const item of plan)for(let turn=1;turn<=item.turns.length;turn++)expected.add(`${item.id}/${round}/${turn}`);
  const observed=report.observations.map(row=>`${row.caseId}/${row.round??1}/${row.turn}`);
  if(report.expectedTurns!==expected.size||observed.length!==expected.size||new Set(observed).size!==expected.size||observed.some(key=>!expected.has(key)))
   failures.push(`${name}: missing, duplicate or unexpected customer turns`);
  if(report.observations.some(row=>row.failures.length))failures.push(`${name}: unresolved deterministic failures`);
  if(JSON.stringify(runtimeFingerprint(report))!==JSON.stringify(runtimeFingerprint(input.candidate)))failures.push(`${name}: runtime differs from candidate`);
  if(!report.sourceHashes['src/lib/agent/engine.ts']||!report.sourceHashes['src/lib/llm/prompt.ts']||!report.sourceHashes['src/lib/agent/self-check.ts'])
   failures.push(`${name}: runtime provenance is missing`);
  if(!report.fixtureState?.knowledgeHash||!report.fixtureState?.configurationHash||
    report.fixtureState.knowledgeHash!==input.candidate.fixtureState?.knowledgeHash||report.fixtureState.configurationHash!==input.candidate.fixtureState?.configurationHash)
   failures.push(`${name}: knowledge or business configuration differs from candidate`);
  const calls=input.captures[name];
  if(calls.length!==report.observations.reduce((n,row)=>n+row.modelCalls,0)||!calls.length||
    calls.some(call=>call.status!==200||!call.responseId?.startsWith('resp_')||!call.model?.startsWith('gpt-6-luna')||!call.usage))
   failures.push(`${name}: missing or invalid genuine provider captures`);
 }
 const rows=[...input.candidate.observations,...input.website.observations];
 return {gate:failures.length?'fail':'pass',failures,uniqueScenarios:new Set(rows.map(row=>row.caseId)).size,
  scorecard:evaluationScorecard(rows,plans.candidate.reduce((n,item)=>n+item.turns.length,0)+plans.website.reduce((n,item)=>n+item.turns.length,0)),
  stressStability:summarizeStability(input.stress.observations,{rounds:input.stress.rounds,turns:Object.fromEntries(plans.stress.map(item=>[item.id,item.turns.length]))})};
}
