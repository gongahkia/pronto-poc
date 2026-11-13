import React from 'react';
import {act,cleanup,render} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({refresh:vi.fn()}));vi.mock('next/navigation',()=>({useRouter:()=>mock}));
import {AutoRefresh} from '@/components/auto-refresh';
afterEach(()=>{cleanup();vi.useRealTimers();vi.clearAllMocks();});
describe('workspace refresh during review',()=>{
 it('keeps feedback and native modal interactions stable until they close',async()=>{
  vi.useFakeTimers();const view=render(<><AutoRefresh/><aside data-feedback-open/></>);
  await act(async()=>{await vi.advanceTimersByTimeAsync(20000);});expect(mock.refresh).not.toHaveBeenCalled();
  view.rerender(<><AutoRefresh/><dialog open/></>);await act(async()=>{await vi.advanceTimersByTimeAsync(20000);});expect(mock.refresh).not.toHaveBeenCalled();
  view.rerender(<><AutoRefresh/><div data-huddle-root data-huddle-open/></>);await act(async()=>{await vi.advanceTimersByTimeAsync(20000);});expect(mock.refresh).not.toHaveBeenCalled();
  view.rerender(<AutoRefresh/>);await act(async()=>{await vi.advanceTimersByTimeAsync(20000);});expect(mock.refresh).toHaveBeenCalledTimes(1);
 });
});
