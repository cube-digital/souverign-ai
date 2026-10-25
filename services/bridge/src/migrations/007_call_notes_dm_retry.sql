-- A "not published" or reminder DM that could not be posted (the inviter's DM with Scribe not
-- keyed yet) is retried by the notes sweep, a few times, further apart each time.
alter table sa.call_notes
  add column dm_pending text check (dm_pending in ('not_published', 'reminder')),
  add column dm_tries int not null default 0,
  add column dm_tried_at timestamptz;
