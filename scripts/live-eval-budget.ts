import { mkdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

// Standard GPT-6 Luna rates, verified 2026-11-08. Ignore cache-read discounts,
// allow 12-hour writes at 2.5x input, and include a 10% regional premium even
// where it may not apply. This is conservative accounting, not an invoice.
export const LUNA_RATES = { input: 0.1, output: 0.5, maximumWriteMultiplier: 2.5, regionalMultiplier: 1.1 };
export const APPROVED_EVAL_LIMIT_USD = 5;
const PRICING_VERSION = "luna-cache-region-v1";
type Charge = { id: string; reservedUsd: number; actualUsd?: number; pricingVersion?: string };
type Ledger = { limitUsd: number; charges: Charge[] };
type Usage = { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cache_write_tokens?: number } };

export function usedBudget(ledger: Ledger): number {
  return ledger.charges.reduce((sum, charge) => sum + (charge.actualUsd ?? charge.reservedUsd), 0);
}
export function requestCostBound(body: string, maxOutput: number): number {
  if (!Number.isInteger(maxOutput) || maxOutput < 1 || maxOutput > 4000)
    throw new Error("Live evaluation requires an explicit output limit of at most 4000 tokens.");
  // UTF-8 bytes plus schema/framing reserve upper-bound the text token count.
  // Charge every reserved token at the larger output rate. Reasoning tokens
  // share max_output_tokens and must not be added to output a second time.
  return (Buffer.byteLength(body, "utf8") + 4096 + maxOutput) * LUNA_RATES.output * LUNA_RATES.regionalMultiplier / 1_000_000;
}
export class LiveEvalBudget {
  constructor(private readonly path: string) {}
  private async update<T>(edit: (ledger: Ledger) => T): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true });
    const lock = `${this.path}.lock`;
    let locked=false;
    for(let attempt=0;attempt<80;attempt++){
      try{await mkdir(lock);locked=true;break;}
      catch(error){
        if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;
        await new Promise(resolve=>setTimeout(resolve,25));
      }
    }
    if(!locked)throw new Error("Another evaluation is updating the budget ledger. Retry after it finishes; do not reset it.");
    try {
      let ledger: Ledger;
      try { ledger = JSON.parse(await readFile(this.path, "utf8")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        ledger = { limitUsd: APPROVED_EVAL_LIMIT_USD, charges: [] };
      }
      if (ledger.limitUsd !== APPROVED_EVAL_LIMIT_USD || !Array.isArray(ledger.charges) ||
          ledger.charges.some(c => !Number.isFinite(c.reservedUsd) || c.reservedUsd < 0 ||
            (c.actualUsd !== undefined && (!Number.isFinite(c.actualUsd) || c.actualUsd < 0))))
        throw new Error("The live evaluation budget ledger is invalid.");
      // Earlier local runs used ordinary input pricing. Increase those settled
      // charges once rather than discard history or undercount cache writes.
      // 3x covers the 2.5x write rate and regional premium, including output.
      for (const charge of ledger.charges) if (charge.actualUsd !== undefined && !charge.pricingVersion) {
        charge.actualUsd *= 3;
        charge.pricingVersion = PRICING_VERSION;
      }
      const result = edit(ledger);
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(ledger, null, 2) + "\n", { mode: 0o600 });
      await rename(temporary, this.path);
      return result;
    } finally { await rmdir(lock); }
  }
  async reserve(body: string, maxOutput: number): Promise<string> {
    const reservedUsd = requestCostBound(body, maxOutput), id = randomUUID();
    return this.update(ledger => {
      if (usedBudget(ledger) + reservedUsd > ledger.limitUsd)
        throw new Error("The cumulative US$5 evaluation budget is exhausted; no request was sent.");
      ledger.charges.push({ id, reservedUsd, pricingVersion: PRICING_VERSION });
      return id;
    });
  }
  async settle(id: string, usage: Usage | undefined) {
    // Missing usage, a timeout, or a crash retains the full pre-call reservation.
    if (!usage || !Number.isInteger(usage.input_tokens) || !Number.isInteger(usage.output_tokens) ||
        usage.input_tokens! < 0 || usage.output_tokens! < 0) return;
    await this.update(ledger => {
      const charge = ledger.charges.find(c => c.id === id);
      if (!charge) throw new Error("Unknown live evaluation charge.");
      const reportedWrites = usage.input_tokens_details?.cache_write_tokens;
      const writes = Number.isInteger(reportedWrites) && reportedWrites! >= 0 && reportedWrites! <= usage.input_tokens!
        ? reportedWrites! : usage.input_tokens!;
      const cost = ((usage.input_tokens! - writes) * LUNA_RATES.input +
        writes * LUNA_RATES.input * LUNA_RATES.maximumWriteMultiplier + usage.output_tokens! * LUNA_RATES.output) *
        LUNA_RATES.regionalMultiplier / 1_000_000;
      if (cost > charge.reservedUsd) throw new Error("Provider usage exceeded the reserved request bound. Stop evaluation.");
      charge.actualUsd = cost;
      charge.pricingVersion = PRICING_VERSION;
    });
  }
  async summary() {
    return this.update(ledger => ({ limitUsd: ledger.limitUsd, accountedUsd: usedBudget(ledger),
      requests: ledger.charges.length, uncertainRequests: ledger.charges.filter(c => c.actualUsd === undefined).length }));
  }
}
