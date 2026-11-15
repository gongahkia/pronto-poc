import {StrictMode} from 'react';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {HuddleFeedback} from '@/components/huddle-feedback';
import {DEMO_CLIENT_ID} from '@/lib/customer-demo-boundary';
const config = {namespace:'pronto-feedback',workspace:DEMO_CLIENT_ID,environment:'development'};
const requests:string[] = [];
beforeEach(() => {requests.length = 0;vi.stubGlobal('fetch',vi.fn(async (input:string) => {
  requests.push(input); const path = new URL(input,'http://localhost:3000').pathname;
  const value = path.endsWith('/session') ? {actor:{id:'named-reviewer',name:'Named reviewer'},scope:{workspace:config.workspace,environment:config.environment},capabilities:{mentions:false,assignment:false,directory:false}} : path.endsWith('/changes') ? {items:[],cursor:'fixture-cursor',hasMore:false,reset:false} : {items:[],nextCursor:null};
  return Response.json(value);
}));});
afterEach(() => {cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});
describe('Pronto consumes the actual packed React/HTTP SDK',() => {
  it('mounts once through StrictMode, uses the host session and releases navigation on teardown',async () => {
    const push = history.pushState, view = render(<StrictMode><HuddleFeedback config={config} inline/></StrictMode>);expect(document.querySelectorAll('[data-huddle-root]')).toHaveLength(1); const root = document.querySelector('[data-huddle-root]')!;expect(root.hasAttribute('data-huddle-collapsed')).toBe(true);fireEvent.click(root.shadowRoot!.querySelector('button[aria-label="Expand feedback"]')!);await waitFor(() => expect(root.shadowRoot!.textContent).toContain('Add pinned comment'));expect(root.hasAttribute('data-huddle-open')).toBe(true);expect(requests.every(path => path.startsWith('/api/demo/feedback/v2/'))).toBe(true);expect(screen.queryByText('Earlier feedback')).toBeNull();view.unmount();expect(document.querySelector('[data-huddle-root]')).toBeNull();expect(history.pushState).toBe(push);
  });
  it('retains the document nonce, adapter and widget across RSC refreshes',() => {
    const view = render(<HuddleFeedback config={config} styleNonce="document-nonce" inline/>), root = document.querySelector('[data-huddle-root]')!;view.rerender(<HuddleFeedback config={{...config}} styleNonce="new-request-nonce" inline/>);expect(document.querySelector('[data-huddle-root]')).toBe(root);expect(root.shadowRoot!.querySelector('style')!.nonce).toBe('document-nonce');
  });
  it('contains an SDK mount failure without starting legacy review or breaking the page',() => {
    const foreign = document.createElement('div');foreign.dataset.huddleRoot = '';document.body.append(foreign);vi.spyOn(console,'error').mockImplementation(() => {});try {render(<HuddleFeedback config={config} inline/>);expect(screen.getByRole('status').textContent).toContain('Feedback is unavailable');expect(screen.queryByRole('button',{name:'Open prototype feedback'})).toBeNull();expect(document.querySelector('[data-huddle-root]')).toBe(foreign);} finally {foreign.remove();}
  });
});
