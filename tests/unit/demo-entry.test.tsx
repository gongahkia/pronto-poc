import {render,screen,cleanup} from '@testing-library/react';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import type {ComponentProps} from 'react';
const mocks=vi.hoisted(()=>({requireUser:vi.fn(),getSessionUser:vi.fn(),assertDemoActor:vi.fn(),redirect:vi.fn((path:string)=>{throw new Error(`redirect:${path}`);}),notFound:vi.fn(()=>{throw new Error('not-found');})}));
vi.mock('@/lib/auth',()=>({requireUser:mocks.requireUser,getSessionUser:mocks.getSessionUser}));
vi.mock('@/lib/customer-demo',()=>({assertDemoActor:mocks.assertDemoActor}));
vi.mock('next/navigation',()=>({redirect:mocks.redirect,notFound:mocks.notFound}));
vi.mock('next/link',()=>({default:({children,href}:ComponentProps<'a'>)=><a href={href}>{children}</a>}));
import DemoEntryPage from '@/app/demo/page';
import Home from '@/app/page';
import {DemoError} from '@/lib/customer-demo-boundary';
const user={userId:'reviewer',clientId:'demo',email:'guest@guest.invalid',name:'Keith',role:'client'};
beforeEach(()=>{vi.clearAllMocks();mocks.requireUser.mockResolvedValue(user);mocks.getSessionUser.mockResolvedValue(user);mocks.assertDemoActor.mockResolvedValue(undefined);vi.stubEnv('PRONTO_CUSTOMER_DEMO_ENABLED','1');});
afterEach(()=>{cleanup();vi.unstubAllEnvs();});
describe('guided demo entry',()=>{
  it('offers both views after checking the existing authenticated demo identity',async()=>{
    render(await DemoEntryPage());
    expect(mocks.requireUser).toHaveBeenCalledWith('client');
    expect(mocks.assertDemoActor).toHaveBeenCalledWith(user);
    expect(screen.getByRole('link',{name:/Guest \/ customer/}).getAttribute('href')).toBe('/demo/customer');
    expect(screen.getByRole('link',{name:/Client \/ business/}).getAttribute('href')).toBe('/client/inbox');
    expect(screen.getByText(/Welcome, Keith/)).toBeTruthy();
  });
  it('does not render the chooser for an unavailable or unauthorized demo',async()=>{
    mocks.assertDemoActor.mockRejectedValue(new DemoError('Unavailable',404));
    await expect(DemoEntryPage()).rejects.toThrow('not-found');
  });
  it('sends returning demo reviewers to the chooser without changing normal account routing',async()=>{
    await expect(Home()).rejects.toThrow('redirect:/demo');
    vi.stubEnv('PRONTO_CUSTOMER_DEMO_ENABLED','');
    await expect(Home()).rejects.toThrow('redirect:/client');
    mocks.getSessionUser.mockResolvedValue({...user,role:'operator'});
    await expect(Home()).rejects.toThrow('redirect:/account');
  });
});
