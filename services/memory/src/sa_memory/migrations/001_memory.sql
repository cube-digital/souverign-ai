create extension if not exists vector;
create schema if not exists sa;
create table if not exists sa.memory_chunks (
  id bigserial primary key,
  namespace text not null check (namespace ~ '^(agent|chat):[A-Za-z0-9_-]+$'),
  kind text not null check (kind in ('conversation', 'knowledge', 'correction', 'meeting')),
  origin_chat_id text,
  source_type text not null,
  source_id text not null,
  source_title text,
  source_ts double precision not null,
  chunk_idx int not null,
  text text not null,
  tsv_en tsvector generated always as (to_tsvector('english', text)) stored,
  tsv_simple tsvector generated always as (to_tsvector('simple', text)) stored,
  embedding vector(512) not null,
  created_at timestamptz not null default now(),
  unique (namespace, source_type, source_id, chunk_idx)
);
create index if not exists memory_chunks_embedding on sa.memory_chunks using hnsw (embedding vector_cosine_ops);
create index if not exists memory_chunks_tsv_en on sa.memory_chunks using gin (tsv_en);
create index if not exists memory_chunks_tsv_simple on sa.memory_chunks using gin (tsv_simple);
create index if not exists memory_chunks_scope on sa.memory_chunks (namespace, origin_chat_id, source_ts);
