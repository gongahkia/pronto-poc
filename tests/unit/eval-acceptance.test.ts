import {describe,it,expect} from 'vitest';
import {assessAcceptance,type EvidenceReport,type ProviderCapture} from '@/lib/evals/acceptance';

const controlled=Array.from({length:12},(_,index)=>({id:`case-${index}`,turns:[{}]}));
const websiteCases=[{id:'website',turns:[{}]}];
function report(cases:typeof controlled,rounds=1):EvidenceReport{
 return {runId:'synthetic',complete:true,runStatus:'completed',rounds,cases:cases.length,expectedTurns:cases.length*rounds,
  provider:'openai',model:'gpt-6-luna',reasoningEffort:'low',
  fixtureState:{knowledgeHash:'knowledge',configurationHash:'configuration'},
  sourceHashes:{'src/lib/agent/engine.ts':'engine','src/lib/llm/prompt.ts':'prompt','src/lib/agent/self-check.ts':'check'},
  observations:Array.from({length:rounds},(_,round)=>cases.map(item=>({caseId:item.id,round:round+1,turn:1,category:'facts',
   expected:{outcome:'answered'},outcome:'answered',ownership:'active',customer:'Hours?',answer:'Standard hours are 10am to 10pm.',delivered:true,failures:[],modelCalls:1}))).flat()};
}
const captures=(count:number):ProviderCapture[]=>Array.from({length:count},()=>({status:200,responseId:'resp_fixture',model:'gpt-6-luna',usage:{input_tokens:100,output_tokens:20}}));
function input(){return {candidate:report(controlled),website:report(websiteCases),stress:report(controlled,3),controlledCases:controlled,websiteCases,
 captures:{candidate:captures(12),website:captures(1),stress:captures(36)}};}

describe('aggregate evidence gate',()=>{
 it('accepts complete matching evidence and every planned stress trial',()=>{
  const result=assessAcceptance(input());expect(result.gate).toBe('pass');expect(result.uniqueScenarios).toBe(13);
  expect(result.stressStability.every(row=>row.stable)).toBe(true);
 });
 it('rejects a missing difficult case even if all remaining rows pass',()=>{
  const evidence=input();evidence.candidate.observations.pop();expect(assessAcceptance(evidence).gate).toBe('fail');
 });
 it('rejects duplicate turns even with the expected row count',()=>{
  const evidence=input();evidence.candidate.observations[11]=evidence.candidate.observations[0];expect(assessAcceptance(evidence).gate).toBe('fail');
 });
 it('rejects old runtime or changed business knowledge',()=>{
  const evidence=input();evidence.stress.sourceHashes['src/lib/agent/self-check.ts']='old';evidence.website.fixtureState.knowledgeHash='changed';
  expect(assessAcceptance(evidence).failures).toEqual(expect.arrayContaining(['stress: runtime differs from candidate','website: knowledge or business configuration differs from candidate']));
 });
 it('rejects missing provider captures and incomplete stress trials',()=>{
  const evidence=input();evidence.captures.candidate.pop();evidence.stress.observations.pop();evidence.stress.complete=false;
  expect(assessAcceptance(evidence).gate).toBe('fail');
 });
 it('keeps an actual customer-facing failure as a failed gate',()=>{
  const evidence=input();evidence.candidate.observations[0].failures=['No delivered acknowledgement'];
  expect(assessAcceptance(evidence).scorecard.automatedGate).toBe('fail');
 });
});
