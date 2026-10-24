alter table sa.users add column if not exists kind text not null default 'person'
  check (kind in ('person', 'seed'));
create table if not exists sa.seed_devices (
  device_id text primary key references sa.devices,
  user_id text not null unique references sa.users,
  enc_secret_key text not null
);
alter table sa.agents add column if not exists scope text not null default 'personal'
  check (scope in ('personal', 'workspace'));
alter table sa.agents add column if not exists roster_id text unique;
alter table sa.agents alter column owner_user_id drop not null;
alter table sa.agents add constraint agents_scope_owner
  check ((scope = 'workspace') = (owner_user_id is null));
alter table sa.agents drop constraint if exists agents_template_check;
alter table sa.agents add constraint agents_template_check
  check (template in ('general', 'devops', 'qa', 'ops', 'dev', 'tech', 'sales', 'scribe'));
create unique index if not exists agents_workspace_name on sa.agents (lower(name)) where scope = 'workspace';
alter table sa.chats add column if not exists key_epoch int not null default 0;
alter table sa.chats add column if not exists topic text;
alter table sa.chats add column if not exists seed_key text unique;
alter table sa.chats add column if not exists history_until_seq bigint;
create table if not exists sa.user_prefs (
  user_id text primary key references sa.users,
  pause_all boolean not null default false,
  last_hello_day date
);
create table if not exists sa.routines (
  id text primary key,
  kind text not null check (kind in ('routine', 'alert_watch')),
  user_id text references sa.users,
  agent_id text not null references sa.agents,
  chat_id text not null references sa.chats,
  days int[] not null default '{1,2,3,4,5}',
  time_hhmm text not null default '09:00' check (time_hhmm ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  prompt text not null check (length(prompt) between 1 and 500),
  paused boolean not null default false,
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  check ((kind = 'routine') = (user_id is not null))
);
create table if not exists sa.alert_posts (alert_key text primary key, posted_at timestamptz not null);
-- ids and timings only; never message text
create table if not exists sa.turn_metrics (
  turn_id text primary key,
  agent_id text not null,
  chat_id text not null,
  thread_root text,
  requester_user_id text,
  trigger text not null,
  queued_ms int,
  eyes_ms int,
  first_token_ms int,
  done_ms int,
  tools int not null default 0,
  outcome text not null check (outcome in ('done', 'stopped', 'error', 'timeout', 'skipped')),
  reask boolean not null default false,
  feedback text check (feedback in ('up', 'down')),
  created_at timestamptz not null default now()
);
create index if not exists turn_metrics_thread on sa.turn_metrics (agent_id, chat_id, thread_root, created_at);
create table if not exists sa.agent_intros (
  agent_id text not null,
  chat_id text not null,
  posted_at timestamptz not null default now(),
  primary key (agent_id, chat_id)
);
