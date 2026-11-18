-- support per-thread ordering checks without scanning unrelated reply history.
create index if not exists outbound_messages_unresolved_thread_idx
  on outbound_messages(client_id, channel_id, external_thread_id, created_at, id)
  where status in ('pending', 'failed', 'sending', 'uncertain');
