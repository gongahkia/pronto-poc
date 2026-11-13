// Staff review is already being created, not an offer requiring permission.
// Keep useful detail questions separate from the declarative acknowledgement.
export function hasCommittedHandoff(answer:string):boolean{
 const statements=answer.match(/[^.!?。！？;\n]+(?:[.!?。！？;]|$)/gu)??[];
 return statements.some(sentence=>!/[?？]\s*$/.test(sentence)&&(
  /\b(?:our|the)\s+team(?:\s+will|['’]ll)\s+(?!(?:not|never)\b)[a-z]/i.test(sentence)||
  /\b(?:i|we)(?:['’]ll|\s+will)\s+(?:ask|contact|notify|refer|pass|forward|get|check|confirm)\b[^.!?\n]{0,80}\b(?:our|the)\s+team\b/i.test(sentence)||
  /(?:我们的|我們的|我们|我們)?(?:团队|團隊|同事|工作人员|工作人員)(?:将会|將會|会|會|将|將)/u.test(sentence)||
  /\b(?:(?:pasukan|pihak)\s+kami|kami)\s+akan\s+(?:membantu|bantu|menyemak|semak|meneliti|menghubungi|mengurus)/i.test(sentence)||
  /எங்கள்\s+குழு[^.!?\n]{0,100}(?:உதவும்|உதவுவார்கள்|பரிசீலிக்கும்|சரிபார்க்கும்|தொடர்புகொள்ளும்)/u.test(sentence)
 ));
}

const notices={
 en:'I can still help with other questions in the meantime.',
 zh:'同时，我仍可回答其他问题。',
 ms:'Sementara itu, saya masih boleh membantu menjawab soalan lain.',
 ta:'இதற்கிடையில், மற்ற கேள்விகளுக்கு நான் தொடர்ந்து உதவ முடியும்.',
};
// This is operational delivery text, like the CSAT footer, not model output or
// a canned substitute for a failed generation. Only add after checking ownership.
export function handoffFollowupNotice(body:string):string{
 if(/[\u0b80-\u0bff]/u.test(body))return notices.ta;
 if(/[\u3400-\u9fff]/u.test(body))return notices.zh;
 if(/\b(?:kami|anda|pasukan|soalan|pertanyaan|perkara|menyemak|membantu)\b/i.test(body))return notices.ms;
 return notices.en;
}
