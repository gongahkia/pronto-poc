import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HuddleFeedback } from '@/components/huddle-feedback';

vi.mock('next/navigation', () => ({ usePathname: () => '/client/inbox' }));
const config = { serverUrl: 'http://localhost:4310', projectId: '11111111-1111-4111-8111-111111111111', environment: 'development' };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Pronto consumes the packed Huddle React helper', () => {
  it('mounts once through StrictMode, opens from its host button and releases navigation on teardown', () => {
    const push = history.pushState;
    const view = render(<StrictMode><HuddleFeedback config={config} inline/></StrictMode>);
    expect(document.querySelectorAll('[data-huddle-root]')).toHaveLength(1);
    const root = document.querySelector('[data-huddle-root]')!;
    expect(root.shadowRoot!.querySelector('.launcher')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Huddle feedback' }));
    expect(root.hasAttribute('data-huddle-open')).toBe(true);
    expect(root.shadowRoot!.textContent).toContain('Connect Huddle');
    view.unmount();
    expect(document.querySelector('[data-huddle-root]')).toBeNull();
    expect(history.pushState).toBe(push);
  });
  it('switches to earlier Pronto feedback without leaving a second widget running', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ viewerId: 'reviewer', threads: [], hasMoreThreads: false }))));
    render(<HuddleFeedback config={config} inline/>);
    fireEvent.click(screen.getByRole('button', { name: 'Earlier feedback' }));
    expect(document.querySelector('[data-huddle-root]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open prototype feedback' }));
    expect(await screen.findByRole('link', { name: 'Export workspace feedback' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use Huddle' }));
    await waitFor(() => expect(document.querySelectorAll('[data-huddle-root]')).toHaveLength(1));
    expect(document.querySelector('[data-feedback-open]')).toBeNull();
  });
  it('retains the document nonce and widget across server refreshes with fresh request nonces', () => {
    const view = render(<HuddleFeedback config={config} styleNonce="document-nonce" inline/>);
    const root = document.querySelector('[data-huddle-root]')!;
    view.rerender(<HuddleFeedback config={{ ...config }} styleNonce="new-rsc-request-nonce" inline/>);
    expect(document.querySelector('[data-huddle-root]')).toBe(root);
    expect(root.shadowRoot!.querySelector('style')!.nonce).toBe('document-nonce');
  });
  it('contains an SDK mount failure so the host keeps its original feedback', () => {
    const foreign = document.createElement('div'); foreign.dataset.huddleRoot = ''; document.body.append(foreign);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(<HuddleFeedback config={config} inline/>);
      expect(screen.getByRole('status').textContent).toContain('Huddle could not start');
      expect(screen.getByRole('button', { name: 'Open prototype feedback' })).toBeTruthy();
      expect(document.querySelector('[data-huddle-root]')).toBe(foreign);
    } finally { foreign.remove(); }
  });
});
