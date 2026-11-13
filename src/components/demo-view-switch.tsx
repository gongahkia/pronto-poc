import Link from 'next/link';
import {ArrowLeftRight} from 'lucide-react';

export function DemoViewSwitch() {
  return <Link href="/demo" prefetch={false} className="ui-button inline-flex items-center gap-2 px-3 py-2 text-sm">
    <ArrowLeftRight size={16} aria-hidden="true"/>Switch demo view
  </Link>;
}
