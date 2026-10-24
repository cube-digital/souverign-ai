create schema if not exists sa;
create table if not exists sa.schema_migrations (version text primary key, applied_at timestamptz not null default now());
create table sa.users (id text primary key, display_name text not null, pin_hash text not null, locale text not null default 'en');
create table sa.sessions (token_hash text primary key, user_id text not null references sa.users, expires_at timestamptz not null);
create table sa.devices (
  id text primary key,
  owner_type text not null check (owner_type in ('user', 'agent')),
  owner_id text not null,
  public_key text not null,
  created_at timestamptz not null default now()
);
create table sa.chats (
  id text primary key,
  title text not null,
  kind text not null check (kind in ('dm', 'group', 'room')),
  created_by text not null references sa.users,
  created_at timestamptz not null default now()
);
create table sa.chat_members (
  chat_id text not null references sa.chats,
  member_type text not null check (member_type in ('user', 'agent')),
  member_id text not null,
  role text not null check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  removed_at timestamptz,
  primary key (chat_id, member_type, member_id)
);
