import {query} from '@/lib/db';
import {demoBusinessScope,businessPresentation} from '@/lib/demo-business';
import {assertCustomerDemoEnabled} from '@/lib/customer-demo-boundary';

export async function getDemoBusinessPresentation(){
 await assertCustomerDemoEnabled();
 const scope=demoBusinessScope();
 const result=await query<{name:string;business_profile:Record<string,unknown>}>(`select name,business_profile from clients
  where id=$1 and slug=$2 and business_profile->>'demoSeed'=$3`,[scope.clientId,scope.slug,scope.seed]);
 if(!result.rows[0])throw new Error('The selected demo business is not prepared.');
 return businessPresentation(result.rows[0]);
}
