import {resolve} from 'node:path';
import {verifyTestDatabase} from './test-db-safety';
import {assertCustomerDemoEnabled} from '../src/lib/customer-demo-boundary';
import {requireRealDemoConfiguration,profileForDemoChoice} from '../src/lib/customer-demo-ai';
import {LiveEvalBudget} from './live-eval-budget';
import {budgetedLunaFetch} from './luna-budget-transport';

await verifyTestDatabase();
await assertCustomerDemoEnabled();
await requireRealDemoConfiguration(true,profileForDemoChoice('openai-local'));
const budget=new LiveEvalBudget(resolve('output/live-eval/budget.json'));
const summary=await budget.summary();
if(summary.accountedUsd>=summary.limitUsd)throw new Error('The original cumulative US$5 evaluation allowance is exhausted.');
globalThis.fetch=budgetedLunaFetch(budget);
process.env.PRONTO_DEMO_ONLY_DELIVERY='1';
console.log(JSON.stringify({event:'local_luna_worker_budgeted',...summary}));
await import('./demo/customer-worker');
