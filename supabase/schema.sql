-- Schema for server.shealthmedia.org (relay command log + podcast CMS).
-- Apply once per Supabase project, then create the Storage bucket named
-- in SUPABASE_BUCKET (default "podcast") as a PUBLIC bucket.
--
-- The relay connects with the service_role key, which bypasses RLS.
-- RLS is enabled with no policies, so anon/authenticated clients get
-- nothing directly — all access goes through the relay's own auth.

create table if not exists public.commands (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  endpoint    text        not null,
  payload     text        not null default '',
  status      text        not null,
  response    text        not null default '',
  duration_ms integer
);

create index if not exists commands_id_desc_idx on public.commands (id desc);

create table if not exists public.episodes (
  id           bigint generated always as identity primary key,
  title        text        not null,
  description  text        not null default '',
  audio_path   text        not null,
  cover_path   text,
  published_at timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index if not exists episodes_published_idx on public.episodes (published_at desc);

create table if not exists public.articles (
  id           bigint generated always as identity primary key,
  title        text        not null,
  body         text        not null default '',
  cover_path   text,
  published_at timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index if not exists articles_published_idx on public.articles (published_at desc);

alter table public.commands enable row level security;
alter table public.episodes enable row level security;
alter table public.articles enable row level security;
