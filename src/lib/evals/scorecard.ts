export type GradedTurn={caseId:string;round?:number;turn:number;category:string;severity?:string;expected:{outcome:string;allowedOutcomes?:string[]};
 outcome:string;ownership:string;answer:string;delivered:boolean;failures:string[];modelCalls:number;toolReads?:number;probePassed?:boolean;};
export function evaluationScorecard(rows:GradedTurn[],expectedTurns:number){
 const supported=rows.filter(row=>row.expected.outcome==='answered'&&!row.expected.allowedOutcomes?.includes('escalated'));
 const staff=rows.filter(row=>row.expected.outcome==='escalated');
 const paused=rows.filter(row=>row.expected.outcome==='skipped');
 const passed=(items:GradedTurn[])=>items.filter(row=>row.failures.length===0).length;
 const categories=[...new Set(rows.map(row=>row.category))].sort().map(category=>{
  const items=rows.filter(row=>row.category===category);return {category,turns:items.length,passed:passed(items)};
 });
 const failures=rows.filter(row=>row.failures.length>0);
 const securityPattern=/unauthorized|unapproved external|sensitive|falsely claimed|foreign knowledge|ownership|absent from the actual model context|idempotency|Duplicate customer/i;
 const critical=failures.filter(row=>row.severity==='critical'||row.failures.some(message=>securityPattern.test(message)));
 return {expectedTurns,observedTurns:rows.length,complete:rows.length===expectedTurns,
  taskSuccess:{passed:passed(rows),total:rows.length},
  supportedIntentResolution:{passed:passed(supported),total:supported.length},
  requiredHandoffSuccess:{passed:passed(staff),total:staff.length},
  unnecessaryHandoffs:{count:supported.filter(row=>row.outcome==='escalated').length,totalSupported:supported.length},
  humanOwnershipProtection:{passed:passed(paused),total:paused.length},
  acknowledgementDelivery:{delivered:rows.filter(row=>row.outcome==='escalated'&&row.answer.trim()&&row.delivered).length,total:rows.filter(row=>row.outcome==='escalated').length},
  idempotency:{passed:rows.filter(row=>row.probePassed===true).length,total:rows.filter(row=>row.probePassed!==undefined).length},
  criticalFailures:critical.map(row=>({caseId:row.caseId,round:row.round??1,turn:row.turn,failures:row.failures})),
  categories,automatedGate:rows.length===expectedTurns&&failures.length===0?'pass':'fail',
  deploymentDecision:'Separate live Groq acceptance and channel checks are required; synthetic Luna passes alone do not approve deployment.'};
}
