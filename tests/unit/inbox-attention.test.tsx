import {render,screen} from '@testing-library/react';
import {describe,it,expect,vi} from 'vitest';
import type {ComponentProps} from 'react';
import type {FilteredConversation} from '@/lib/reporting';
import {ConversationList} from '@/components/reporting-panels';

vi.mock('next/image',()=>({default:()=>null}));
vi.mock('next/link',()=>({default:({children,...props}:ComponentProps<'a'>)=><a {...props}>{children}</a>}));

describe('inbox staff attention',()=>{
  it('never dims a pending staff issue as resolved after an AI acknowledgement',()=>{
    const row:FilteredConversation={id:'thread',client_id:'client',client_name:'Demo restaurant',channel_kind:'console',
      customer_name:'Customer waiting for staff',customer_handle:'customer',status:'active',last_message_at:new Date(),created_at:new Date(),
      last_message:'Our team will review your refund. Standard hours are 10am–10pm.',last_sender_role:'agent',
      active_escalation_id:'review',active_escalation_status:'open',active_escalation_reason_code:'complaint_or_refund',
      assigned_to_user_id:null,assigned_to_name:null,delivery_status:'sent',owner_action_required:true,is_resolved:true};
    render(<ConversationList conversations={[row]} hrefForConversation={()=>'/thread'}/>);
    expect(screen.getByRole('link').getAttribute('data-resolved')).toBe('false');
    expect(screen.getByLabelText('Needs team reply')).toBeTruthy();
    expect(screen.getByText(/Pronto can answer other questions/)).toBeTruthy();
    expect(screen.queryByLabelText('Resolved')).toBeNull();
  });
});
