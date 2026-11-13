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
import LoginPage from '@/app/login/page';
import EnterDemoPage from '@/app/enter/page';
import {DemoError,DEMO_CLIENT_ID} from '@/lib/customer-demo-boundary';
const user={userId:'reviewer',clientId:DEMO_CLIENT_ID,email:'guest@guest.invalid',name:'Keith',role:'client'};
beforeEach(()=>{vi.clearAllMocks();mocks.requireUser.mockResolvedValue(user);mocks.getSessionUser.mockResolvedValue(user);mocks.assertDemoActor.mockResolvedValue(undefined);vi.stubEnv('PRONTO_CUSTOMER_DEMO_ENABLED','1');});
afterEach(()=>{cleanup();vi.unstubAllEnvs();});
describe('guided demo entry',()=>{
  it('offers both views after checking the existing authenticated demo identity',async()=>{
    render(await DemoEntryPage());
    expect(mocks.assertDemoActor).toHaveBeenCalledWith(user);
    expect(screen.getByRole('link',{name:/Guest \/ customer/}).getAttribute('href')).toBe('/demo/customer');
    expect(screen.getByRole('link',{name:/Client \/ business/}).getAttribute('href')).toBe('/client/inbox');
    expect(screen.getByText(/Welcome, Keith/)).toBeTruthy();
  });
  it('lets a new visitor choose either view directly with an optional name',async()=>{
    mocks.getSessionUser.mockResolvedValue(null);
    render(await DemoEntryPage());
    expect(screen.getByRole('button',{name:/Guest \/ customer/}).getAttribute('value')).toBe('/demo/customer');
    expect(screen.getByRole('button',{name:/Client \/ business/}).getAttribute('value')).toBe('/client/inbox');
    expect(screen.getByLabelText(/Your name/).hasAttribute('required')).toBe(false);
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(mocks.assertDemoActor).not.toHaveBeenCalled();
    expect(mocks.requireUser).not.toHaveBeenCalled();
  });
  it('routes anonymous home and legacy entry links to the chooser',async()=>{
    mocks.getSessionUser.mockResolvedValue(null);
    await expect(Home()).rejects.toThrow('redirect:/demo');
    await expect(LoginPage({searchParams:Promise.resolve({})})).rejects.toThrow('redirect:/demo');
    await expect(EnterDemoPage({searchParams:Promise.resolve({})})).rejects.toThrow('redirect:/demo');
  });
  it('keeps ordinary sign-in available when the demo is disabled',async()=>{
    vi.stubEnv('PRONTO_CUSTOMER_DEMO_ENABLED','');mocks.getSessionUser.mockResolvedValue(null);
    await expect(Home()).rejects.toThrow('redirect:/login');
    render(await LoginPage({searchParams:Promise.resolve({})}));
    expect(screen.getByLabelText('Email')).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
    await expect(DemoEntryPage()).rejects.toThrow('not-found');
    await expect(EnterDemoPage({searchParams:Promise.resolve({})})).rejects.toThrow('not-found');
  });
  it('does not render the chooser for an unavailable or unauthorized demo',async()=>{
    mocks.assertDemoActor.mockRejectedValue(new DemoError('Unavailable',404));
    await expect(DemoEntryPage()).rejects.toThrow('not-found');
  });
  it('sends returning demo reviewers to the chooser without changing normal account routing',async()=>{
    await expect(Home()).rejects.toThrow('redirect:/demo');
    mocks.getSessionUser.mockResolvedValue({...user,clientId:'another-business'});
    await expect(Home()).rejects.toThrow('redirect:/client');
    mocks.getSessionUser.mockResolvedValue(user);
    vi.stubEnv('PRONTO_CUSTOMER_DEMO_ENABLED','');
    await expect(Home()).rejects.toThrow('redirect:/client');
    mocks.getSessionUser.mockResolvedValue({...user,role:'operator'});
    await expect(Home()).rejects.toThrow('redirect:/account');
  });
});
