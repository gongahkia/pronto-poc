'use client';

import {Component,useMemo,useState,type ReactNode} from 'react';
import {useHuddle} from '@huddle/browser/react';
import {createHttpAdapter} from '@huddle/browser/http';
import {CollaborationError} from '@huddle/browser';
import type {HuddleReviewConfig} from '@/lib/huddle-config';

const excludeReviewElement = (element:Element) => !!element.closest('[data-feedback-private],[data-feedback-ui],input,textarea,select,[contenteditable="true"]');
class ReviewBoundary extends Component<{children:ReactNode;inline:boolean},{failed:boolean}> {
  state = {failed:false};
  static getDerivedStateFromError() {return {failed:true};}
  render() {
    if(this.state.failed) return <div data-feedback-ui className={this.props.inline ? '' : 'fixed bottom-4 right-4 z-40'}><p role="status" className="text-xs text-muted">Feedback is unavailable. The page remains usable.</p></div>;
    return this.props.children;
  }
}
async function changeReviewerName(name:string,signal:AbortSignal){
  if(name.length>40)throw new CollaborationError('validation','Use a name of 40 characters or fewer.');
  const response=await fetch('/api/demo/feedback/profile',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({name}),signal}),value=await response.json().catch(()=>({error:'Could not update your name.'}));
  if(!response.ok)throw new CollaborationError(response.status===401?'unauthenticated':response.status===403?'forbidden':response.status===429?'rate_limited':response.status<500?'validation':'unavailable',typeof value.error==='string'?value.error:'Could not update your name.');
}
export function HuddleFeedback(props:{config:HuddleReviewConfig;styleNonce?:string;inline?:boolean;readOnly?:boolean;canEditName?:boolean}) {
  return <ReviewBoundary inline={props.inline ?? false}><ReviewToolbar {...props}/></ReviewBoundary>;
}
function ReviewToolbar({config,styleNonce,inline=false,readOnly=false,canEditName=false}:{config:HuddleReviewConfig;styleNonce?:string;inline?:boolean;readOnly?:boolean;canEditName?:boolean}) {
  // the active document retains its CSP nonce across RSC refreshes.
  const [documentNonce] = useState(() => typeof document === 'undefined' ? styleNonce : document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce || styleNonce);
  const adapter = useMemo(() => createHttpAdapter({basePath:'/api/demo/feedback/v2'}),[]);
  useHuddle({...config,adapter,styleNonce:documentNonce,excludeElement:excludeReviewElement,onDisplayNameChange:canEditName?changeReviewerName:undefined});
  return readOnly ? <div data-feedback-ui className={inline ? '' : 'fixed bottom-20 right-4 z-40'}><p role="status" className="text-xs text-muted">Feedback is read-only. Export remains available.</p></div> : null;
}
