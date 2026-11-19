import React from 'react';
import {act,cleanup,render} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({refresh:vi.fn()}));vi.mock('next/navigation',()=>({useRouter:()=>mock}));
import {AutoRefresh} from '@/components/auto-refresh';
afterEach(()=>{cleanup();vi.useRealTimers();vi.clearAllMocks();});
describe('workspace refresh',()=>{
 it('keeps native modal and input interactions stable until they close',async()=>{
  vi.useFakeTimers();const view=render(<><AutoRefresh/><dialog open/></>);
  await act(async()=>{await vi.advanceTimersByTimeAsync(20000);});expect(mock.refresh).not.toHaveBeenCalled();
  view.rerender(<><AutoRefresh/><input aria-label="Reply"/></>);
  view.getByRole('textbox').focus();await act(async()=>{await vi.advanceTimersByTimeAsync(20000);});expect(mock.refresh).not.toHaveBeenCalled();
  view.getByRole('textbox').blur();await act(async()=>{await vi.advanceTimersByTimeAsync(20000);});expect(mock.refresh).toHaveBeenCalledTimes(1);
  view.rerender(<AutoRefresh/>);await act(async()=>{await vi.advanceTimersByTimeAsync(20000);});expect(mock.refresh).toHaveBeenCalledTimes(2);
 });
});
