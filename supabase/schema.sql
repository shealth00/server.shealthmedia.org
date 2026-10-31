-- Podcast CMS schema for the Supabase project "Media" (ref yatasgixudnowtrzqteu).
-- Applied 2026-09-29 as migration `podcast_cms_schema`.
--
-- The relay connects with the service_role key, which bypasses RLS. RLS is
-- enabled with NO policies, so anon/publishable clients get nothing directly:
-- every read and write goes through the relay's own auth (public GETs, and
-- X-Client-Token for writes). The Supabase linter reporting
-- "RLS enabled, no policy" on these two tables is therefore expected.
--
-- The relay's VirtualDJ/GarageBand command log stays in local SQLite
-- (better-sqlite3, relay-server/virtualdj.db) and is NOT part of this schema.

create table if not exists public.episodes (
  id           bigint generated always as identity primary key,
  title        text        not null,
  description  text        not null default '',
  audio_path   text        not null,
  cover_path   text,
  published_at timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index if not exists episodes_published_idx on public.episodes (published_at desc, id desc);

create table if not exists public.articles (
  id           bigint generated always as identity primary key,
  title        text        not null,
  body         text        not null default '',
  cover_path   text,
  published_at timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index if not exists articles_published_idx on public.articles (published_at desc, id desc);

alter table public.episodes enable row level security;
alter table public.articles enable row level security;

-- Public Storage bucket holding episode audio (audio/) and cover images (covers/).
insert into storage.buckets (id, name, public)
values ('podcast', 'podcast', true)
on conflict (id) do update set public = true;
