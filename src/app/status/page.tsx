import {ServiceStatus} from '@/components/service-status';
// The request proxy supplies a per-request CSP nonce for hydration scripts.
export const dynamic='force-dynamic';
export default function StatusPage(){return <ServiceStatus/>;}
