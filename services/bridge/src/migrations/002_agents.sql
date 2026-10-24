create table sa.agents (
  id text primary key,
  owner_user_id text not null references sa.users,
  name text not null,
  template text not null check (template in ('general', 'devops', 'qa')),
  soul text not null default '',
  status text not null default 'stopped',
  api_port int unique,
  created_at timestamptz not null default now(),
  unique (owner_user_id, name)
);
create table sa.agent_devices (
  device_id text primary key references sa.devices,
  agent_id text not null unique references sa.agents,
  enc_secret_key text not null
);
create table sa.agent_chat_keys (
  device_id text not null,
  chat_id text not null,
  epoch int not null,
  key_enc text not null,
  primary key (device_id, chat_id, epoch)
);
create table sa.agent_cursors (
  device_id text not null,
  chat_id text not null,
  seq bigint not null,
  primary key (device_id, chat_id)
);
create table sa.messages_plain (
  device_id text not null,
  chat_id text not null,
  id text not null,
  seq bigint not null,
  sender_device text not null,
  epoch int not null,
  body jsonb not null,
  ts bigint not null,
  primary key (device_id, id)
);
