'use client';

import { Component, useState, type ReactNode } from 'react';
import { useHuddle } from '@huddle/browser/react';
import type { HuddleReviewConfig } from '@/lib/huddle-config';
import { DemoFeedback } from '@/components/demo-feedback';

class ReviewBoundary extends Component<{ children: ReactNode; inline: boolean }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div data-feedback-ui className={this.props.inline ? '' : 'fixed bottom-4 right-4 z-40'}>
      <p role="status" className="text-xs text-muted">Huddle could not start. Pronto feedback is available.</p>
      <DemoFeedback inline/>
    </div>;
    return this.props.children;
  }
}

export function HuddleFeedback(props: { config: HuddleReviewConfig; styleNonce?: string; inline?: boolean }) {
  return <ReviewBoundary inline={props.inline ?? false}><ReviewToolbar {...props}/></ReviewBoundary>;
}

function ReviewToolbar({ config, styleNonce, inline = false }: { config: HuddleReviewConfig; styleNonce?: string; inline?: boolean }) {
  const [earlierFeedback, setEarlierFeedback] = useState(false);
  // RSC refreshes have a new request nonce, but this document keeps its original
  // CSP. Preserve that nonce so polling does not remount/disconnect the widget.
  const [documentNonce] = useState(() => typeof document === 'undefined' ? styleNonce :
    document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce || styleNonce);
  const review = useHuddle(earlierFeedback ? null : { ...config, styleNonce: documentNonce, launcher: 'hidden' });
  return <div data-feedback-ui className={inline ? 'flex flex-wrap items-center gap-2' : 'fixed bottom-4 right-4 z-40 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel p-2 shadow-lg'}>
    {earlierFeedback ? <>
      <DemoFeedback inline/>
      <button type="button" className="ui-button px-3 py-2 text-sm" onClick={() => setEarlierFeedback(false)}>Use Huddle</button>
    </> : <>
      <button type="button" className="ui-primary-button min-h-11 rounded-lg px-3 py-2 text-sm" onClick={() => review.open()}>Huddle feedback</button>
      <button type="button" className="ui-button px-3 py-2 text-sm" onClick={() => setEarlierFeedback(true)}>Earlier feedback</button>
    </>}
  </div>;
}
