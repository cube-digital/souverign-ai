create table sa.calls (
  id text primary key,
  chat_id text not null references sa.chats on delete cascade,
  room text not null unique,
  started_by text not null references sa.users,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  anchor_message_id text,
  e2ee boolean not null default false
);
create unique index calls_one_active_per_chat on sa.calls (chat_id) where ended_at is null;

create table sa.call_participants (
  call_id text not null references sa.calls on delete cascade,
  user_id text not null references sa.users,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  primary key (call_id, user_id)
);

create table sa.call_notetakers (
  id text primary key,
  call_id text not null references sa.calls on delete cascade,
  agent_id text not null references sa.agents,
  invited_by text not null references sa.users,
  status text not null default 'active' check (status in ('active', 'stopped', 'finished', 'failed')),
  worker text not null default 'starting' check (worker in ('starting', 'joined', 'left', 'error', 'fake')),
  stopped_by text references sa.users,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);
create unique index call_notetakers_one_active on sa.call_notetakers (call_id) where status = 'active';

create table sa.call_consents (
  notetaker_id text not null references sa.call_notetakers on delete cascade,
  user_id text not null references sa.users,
  decision text not null check (decision in ('accepted', 'declined')),
  decided_at timestamptz not null default now(),
  primary key (notetaker_id, user_id)
);

create table sa.call_segments (
  id bigserial primary key,
  notetaker_id text not null references sa.call_notetakers on delete cascade,
  speaker_user_id text not null references sa.users,
  t0 timestamptz not null,
  t1 timestamptz not null,
  text text not null check (length(text) <= 4000),
  lang text
);
create index call_segments_by_notetaker on sa.call_segments (notetaker_id, t0);

create table sa.call_notes (
  id text primary key,
  notetaker_id text not null references sa.call_notetakers on delete cascade,
  version int not null,
  final boolean not null default false,
  body_md text not null,
  action_items jsonb not null default '[]',
  status text not null default 'draft' check (status in ('draft', 'pending_approval', 'published', 'not_published')),
  approval_id text,
  approval_requested_at timestamptz,
  reminded_at timestamptz,
  published_message_id text,
  created_at timestamptz not null default now(),
  unique (notetaker_id, version)
);
create unique index call_notes_one_final on sa.call_notes (notetaker_id) where final;
