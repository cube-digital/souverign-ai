alter table sa.agents add column if not exists share_private_in_chats text not null default 'always'
  check (share_private_in_chats in ('always', 'ask', 'never'));
create table if not exists sa.agent_lessons (
  id text primary key,
  agent_id text not null references sa.agents,
  text text not null check (length(text) between 1 and 500),
  taught_by text references sa.users,
  created_at timestamptz not null default now()
);
create index if not exists agent_lessons_agent on sa.agent_lessons (agent_id, created_at);
create table if not exists sa.knowledge_items (
  id text primary key,
  agent_id text not null references sa.agents,
  kind text not null check (kind in ('document', 'note', 'correction')),
  title text not null check (length(title) between 1 and 200),
  mime text,
  size int,
  -- [{label: string|null, text: string}] as extracted; the source viewer reads it
  parts jsonb not null default '[]',
  truncated boolean not null default false,
  tags text[] not null default '{}',
  origin_chat_id text references sa.chats,
  target_message_id text,
  taught_by text references sa.users,
  created_at timestamptz not null default now()
);
create index if not exists knowledge_items_agent on sa.knowledge_items (agent_id, created_at desc);
create table if not exists sa.memory_ingested (
  chat_id text not null,
  message_id text not null,
  ingested_at timestamptz not null default now(),
  primary key (chat_id, message_id)
);
create table if not exists sa.approvals (
  id text primary key,
  agent_id text not null references sa.agents,
  chat_id text not null references sa.chats,
  reply_to text,
  turn_id text,
  kind text not null check (kind in ('tool', 'share')),
  -- open registry: validated in code (registerGatedTool), never a closed list here
  tool text not null check (tool ~ '^[a-z][a-z0-9_]{1,63}$'),
  args jsonb not null,
  preview jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'executed', 'failed', 'denied', 'expired', 'canceled')),
  requester_user_id text references sa.users,
  approver_user_id text not null references sa.users,
  decided_by text references sa.users,
  decided_at timestamptz,
  auto boolean not null default false,
  result text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check ((status = 'pending') = (decided_at is null))
);
create index if not exists approvals_approver on sa.approvals (approver_user_id, status, created_at desc);
create index if not exists approvals_pending on sa.approvals (expires_at) where status = 'pending';
create table if not exists sa.approval_grants (
  user_id text not null references sa.users,
  agent_id text not null references sa.agents,
  tool text not null check (tool ~ '^[a-z][a-z0-9_]{1,63}$'),
  created_at timestamptz not null default now(),
  primary key (user_id, agent_id, tool)
);
create table if not exists sa.notes (
  id text primary key,
  agent_id text not null references sa.agents,
  chat_id text not null references sa.chats,
  title text not null check (length(title) between 1 and 200),
  body_md text not null check (length(body_md) <= 20000),
  approval_id text references sa.approvals,
  created_at timestamptz not null default now()
);
create index if not exists notes_chat on sa.notes (chat_id, created_at desc);
create table if not exists sa.outbox (
  id text primary key,
  agent_id text not null references sa.agents,
  approval_id text references sa.approvals,
  to_addr text not null,
  subject text not null,
  file text not null,
  created_at timestamptz not null default now()
);
create table if not exists sa.questions (
  id text primary key,
  agent_id text not null references sa.agents,
  chat_id text not null references sa.chats,
  reply_to text,
  turn_id text,
  message_id text,
  requester_user_id text not null references sa.users,
  question text not null check (length(question) between 1 and 500),
  options jsonb not null default '[]',
  status text not null default 'open' check (status in ('open', 'answered', 'expired', 'canceled')),
  answer text check (length(answer) <= 1000),
  answered_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists questions_open on sa.questions (expires_at) where status = 'open';
