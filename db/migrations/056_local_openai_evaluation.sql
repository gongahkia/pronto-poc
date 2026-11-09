-- An explicit local-only model choice. Server-side deployment gates still
-- refuse it in production; this migration does not enable a provider.
alter table customer_demo_sessions drop constraint customer_demo_sessions_ai_selection_check;
alter table customer_demo_sessions add constraint customer_demo_sessions_ai_selection_check
  check (ai_selection in ('configured','mock','gemini-flash','groq-oss','gemini-lite','openai-local'));
