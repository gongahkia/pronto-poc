-- Old handoffs retain their original pause. Only new, explicitly eligible
-- automated reviews permit grounded follow-ups before a responder claims them.
alter table escalations add column allow_ai_followups boolean not null default false;
