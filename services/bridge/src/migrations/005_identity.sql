alter table sa.users add column if not exists email text unique check (email = lower(email));
create table if not exists sa.identities (
  provider text not null,
  subject text not null,
  user_id text not null references sa.users,
  email text not null,
  created_at timestamptz not null default now(),
  last_login_at timestamptz not null default now(),
  primary key (provider, subject),
  unique (provider, user_id)
);
