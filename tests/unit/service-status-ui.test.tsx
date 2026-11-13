import {render,screen,act,cleanup} from '@testing-library/react';
import {it,expect,vi} from 'vitest';
import {ServiceStatus} from '@/components/service-status';
it('displays a 503 report with a working app and failed replies instead of hiding it behind a fetch error',async()=>{
 const fetch=vi.fn(async()=>new Response(JSON.stringify({status:'degraded',checkedAt:'2026-11-13T07:00:00Z',revision:null,providerProbe:false,checks:[
  {id:'app',name:'Application',state:'ok',detail:'The web service is responding.'},
  {id:'provider',name:'AI replies',state:'warning',detail:'An AI response ended early.',code:'output_truncated'}]}),{status:503}));
 vi.stubGlobal('fetch',fetch);render(<ServiceStatus/>);
 await screen.findByText('Service needs attention');expect(screen.getByText('The web service is responding.')).toBeTruthy();
 expect(screen.getByText('output_truncated')).toBeTruthy();expect(screen.queryByRole('alert')).toBeNull();
 expect(fetch).toHaveBeenCalledWith('/api/status',expect.objectContaining({cache:'no-store'}));cleanup();
});
it('recovers automatically without generating an AI request',async()=>{
 vi.useFakeTimers();
 const fetch=vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(new Response(JSON.stringify({status:'operational',checkedAt:'2026-11-13T07:00:00Z',checks:[],providerProbe:false})));
 vi.stubGlobal('fetch',fetch);
 try{render(<ServiceStatus/>);await act(async()=>{await vi.advanceTimersByTimeAsync(0);});expect(screen.getByRole('alert')).toBeTruthy();
  await act(async()=>{await vi.advanceTimersByTimeAsync(30000);});expect(screen.queryByRole('alert')).toBeNull();expect(screen.getByText('Service checks passed')).toBeTruthy();
  expect(fetch.mock.calls.every(call=>call[0]==='/api/status')).toBe(true);
 }finally{cleanup();vi.useRealTimers();}
});
