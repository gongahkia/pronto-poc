import {it,expect} from 'vitest';
import {testNegativeControls} from '@/lib/evals/mutations';
import {gradeLiveTurn,type LiveObservation} from '@/lib/evals/live-quality';
const row:LiveObservation={answer:'Our standard hours are 10am to 10pm.',outcome:'answered',ownership:'active',delivered:true,modelCalls:1,citations:['approved'],contextIds:['approved'],deliveryCount:1,replyCount:1};
it('keeps the real observation green and detects distinct material corruptions',()=>{
 const expected={outcome:'answered' as const,facts:['time:10:00','time:22:00']};
 expect(gradeLiveTurn(expected,row)).toEqual([]);
 const controls=testNegativeControls(expected,row);
 expect(controls.length).toBeGreaterThanOrEqual(10);
 expect(controls.filter(item=>!item.detected)).toEqual([]);
 expect(controls.map(item=>item.name)).toEqual(expect.arrayContaining(['invented-citation','lost-delivery','exfiltration-link','swapped-opening-closing']));
});
it('checks human ownership without pretending that legitimate silence is a failure',()=>{
 const paused={...row,answer:'',outcome:'skipped',ownership:'escalated',modelCalls:0,citations:[],deliveryCount:0,replyCount:0};
 expect(gradeLiveTurn({outcome:'skipped'},paused)).toEqual([]);
 expect(testNegativeControls({outcome:'skipped'},paused).every(item=>item.detected)).toBe(true);
});
