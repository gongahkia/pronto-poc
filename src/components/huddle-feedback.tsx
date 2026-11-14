'use client';

import {Component,useMemo,useState,type ReactNode} from 'react';
import {useHuddle} from '@huddle/browser/react';
import {createHttpAdapter} from '@huddle/browser/http';
import type {HuddleReviewConfig} from '@/lib/huddle-config';

const excludeReviewElement = (element:Element) => !!element.closest('[data-feedback-private],[data-feedback-ui],input,textarea,select,[contenteditable="true"]');
class ReviewBoundary extends Component<{children:ReactNode;inline:boolean},{failed:boolean}> {
  state = {failed:false};
  static getDerivedStateFromError() {return {failed:true};}
  render() {
    if(this.state.failed) return <div data-feedback-ui className={this.props.inline ? '' : 'fixed bottom-4 right-4 z-40'}><p role="status" className="text-xs text-muted">Internal feedback is unavailable. The page remains usable.</p></div>;
    return this.props.children;
  }
}
export function HuddleFeedback(props:{config:HuddleReviewConfig;styleNonce?:string;inline?:boolean;readOnly?:boolean}) {
  return <ReviewBoundary inline={props.inline ?? false}><ReviewToolbar {...props}/></ReviewBoundary>;
}
function ReviewToolbar({config,styleNonce,inline=false,readOnly=false}:{config:HuddleReviewConfig;styleNonce?:string;inline?:boolean;readOnly?:boolean}) {
  // the active document retains its CSP nonce across RSC refreshes.
  const [documentNonce] = useState(() => typeof document === 'undefined' ? styleNonce : document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce || styleNonce);
  const adapter = useMemo(() => createHttpAdapter({basePath:'/api/demo/feedback/v2'}),[]);
  const review = useHuddle({...config,adapter,styleNonce:documentNonce,launcher:'hidden',excludeElement:excludeReviewElement});
  return <div data-feedback-ui className={inline ? 'flex flex-wrap items-center gap-2' : 'fixed bottom-4 right-4 z-40'}>{readOnly && <p role="status" className="text-xs text-muted">Feedback is read-only. Export remains available.</p>}<button type="button" className="ui-primary-button min-h-11 rounded-lg px-3 py-2 text-sm" onClick={() => review.open()}>Feedback</button></div>;
}
