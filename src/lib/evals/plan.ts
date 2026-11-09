import type {LiveCase} from '../../../evals/live-customer-cases';

export function seededCaseOrder<T>(items: readonly T[], seed: number): T[] {
  if (!Number.isSafeInteger(seed)) throw new Error('Use an integer evaluation seed.');
  let state=seed>>>0;
  const result=[...items];
  for(let i=result.length-1;i>0;i--){
    state=(Math.imul(1664525,state)+1013904223)>>>0;
    const j=Math.floor(state/4294967296*(i+1));
    [result[i],result[j]]=[result[j],result[i]];
  }
  return result;
}
export function validateLiveCorpus(cases: readonly LiveCase[]) {
  const ids=new Set<string>();
  for(const item of cases){
    if(ids.has(item.id))throw new Error(`Duplicate evaluation case: ${item.id}`);
    ids.add(item.id);
    if(!item.turns.length)throw new Error(`Empty evaluation case: ${item.id}`);
    for(const turn of item.turns){
      if(!turn.customer.trim()||turn.customer.length>4000)throw new Error(`Invalid customer message: ${item.id}`);
      for(const regex of [...turn.expect.required??[],...turn.expect.forbidden??[]])new RegExp(regex,'iu');
      if(turn.expect.outcome==='skipped' && (turn.expect.question||turn.expect.facts?.length))throw new Error(`Inconsistent skipped expectation: ${item.id}`);
    }
  }
  return {cases:cases.length,turns:cases.reduce((n,item)=>n+item.turns.length,0)};
}
export function summarizeStability(rows: {caseId:string;turn:number;round?:number;failures:string[];category:string}[],
  plan?:{turns:Record<string,number>;rounds:number}) {
  const cases=new Map<string,{category:string;trials:Map<number,{passing:boolean;turns:Set<number>}>}>();
  for(const row of rows){
    const record=cases.get(row.caseId)??{category:row.category,trials:new Map<number,{passing:boolean;turns:Set<number>}>()};
    const round=row.round??1;
    const trial=record.trials.get(round)??{passing:true,turns:new Set<number>()};
    trial.passing&&=row.failures.length===0;trial.turns.add(row.turn);record.trials.set(round,trial);
    cases.set(row.caseId,record);
  }
  if(plan)for(const id of Object.keys(plan.turns))if(!cases.has(id))cases.set(id,{category:'unobserved',trials:new Map()});
  return [...cases].map(([caseId,r])=>{
    const passingTrials=[...r.trials.values()].filter(trial=>trial.passing&&(!plan||trial.turns.size===plan.turns[caseId])).length;
    return {caseId,category:r.category,trials:r.trials.size,passingTrials,
      stable:passingTrials===(plan?.rounds??r.trials.size),
      ...(plan?{plannedTrials:plan.rounds,completeTrials:[...r.trials.values()].filter(trial=>trial.turns.size===plan.turns[caseId]).length}:{}),
    };
  });
}
