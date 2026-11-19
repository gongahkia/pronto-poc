import {afterEach,describe,expect,it,vi} from 'vitest';
import original from '../../config/demo-businesses/ps-cafe.json';
import example from '../../config/demo-businesses/example-business.json';
import {demoBusinessScope,LEGACY_DEMO_SCOPE,businessPresentation} from '@/lib/demo-business';
import {parseDemoBusinessProfile,demoBusinessEnvironment,demoBusinessProfileHash} from '@/lib/demo-business-profile';

afterEach(()=>vi.unstubAllEnvs());
describe('saved demo business configuration',()=>{
 it('retains the original identity only when every override is absent',()=>{
  expect(demoBusinessScope({})).toEqual(LEGACY_DEMO_SCOPE);
  expect(()=>demoBusinessScope({PRONTO_DEMO_CLIENT_ID:example.identity.clientId})).toThrow(/all four/);
  expect(()=>demoBusinessScope({PRONTO_DEMO_CLIENT_ID:''})).toThrow(/all four/);
  expect(demoBusinessScope(demoBusinessEnvironment(example.identity))).toEqual(example.identity);
  expect(demoBusinessScope({})).toEqual(LEGACY_DEMO_SCOPE);
 });
 it('reads the selected identity per operation and never mutates the legacy fixture',()=>{
  for(const [key,value]of Object.entries(demoBusinessEnvironment(example.identity)))vi.stubEnv(key,value);
  expect(demoBusinessScope()).toEqual(example.identity);
  expect(LEGACY_DEMO_SCOPE.clientId).toBe(original.identity.clientId);
 });
 it('validates both versioned profiles and changes the review hash when facts change',()=>{
  const profile=parseDemoBusinessProfile(example);
  expect(parseDemoBusinessProfile(original).knowledge).toHaveLength(3);
  expect(demoBusinessProfileHash(profile)).toMatch(/^[a-f0-9]{64}$/);
  const changed=structuredClone(profile);changed.knowledge[0].content+=' Staff can help.';
  expect(demoBusinessProfileHash(changed)).not.toBe(demoBusinessProfileHash(profile));
 });
 it.each([
  {...example,credentials:{token:'never-import'}},
  {...example,unofficialDemo:false},
  {...example,identity:{...example.identity,channelId:example.identity.clientId}},
  {...example,knowledge:[{...example.knowledge[0],id:example.identity.clientId}]},
  {...example,knowledge:[{...example.knowledge[0],secondaryUrl:'https://user:secret@example.com/'}]},
  {...example,presentation:{...example.presentation,logoPath:'https://example.com/logo.svg'}},
  {...example,timezone:'not-a-timezone'},
 ])('rejects unsafe or inconsistent profile input',value=>expect(()=>parseDemoBusinessProfile(value)).toThrow());
 it('uses business-specific branding with a neutral fallback',()=>{
  const profile=parseDemoBusinessProfile(example);
  expect(businessPresentation({name:profile.name,business_profile:{demoPresentation:profile.presentation}})).toEqual(profile.presentation);
  const fallback=businessPresentation({name:'Another business'});
  expect(fallback.logoPath).toBeNull();expect(fallback.assistantLabel).toBe('Another business assistant');
  expect(JSON.stringify(fallback)).not.toContain('PS.Cafe');
 });
});
