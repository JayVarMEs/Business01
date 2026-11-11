-- MakersBridge database schema for Supabase (PostgreSQL)
-- Run in: Supabase dashboard > SQL Editor > New query > paste > Run.

-- 1) Tables ------------------------------------------------------------
create table public.products (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,
  name        text not null,
  seller      text not null,
  price_thb   integer not null check (price_thb > 0),
  kind        text not null check (kind in ('ready','preorder')),
  categories  text[] not null default '{}',
  image_url   text,
  rating      numeric(2,1),
  sold_count  integer not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table public.campaigns (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid references public.products(id) on delete set null,
  title       text not null,
  seller      text not null,
  description text,
  minimum     integer not null check (minimum > 0),
  deposit_thb integer not null check (deposit_thb > 0),
  ends_at     timestamptz not null,
  active      boolean not null default true
);

create table public.orders (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  status      text not null default 'pending'
              check (status in ('pending','paid','cancelled','refunded')),
  total_thb   integer not null check (total_thb >= 0),
  created_at  timestamptz not null default now()
);

create table public.order_items (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders(id) on delete cascade,
  product_id    uuid references public.products(id),
  campaign_id   uuid references public.campaigns(id),
  name          text not null,              -- snapshot of the name at purchase time
  unit_price_thb integer not null,          -- snapshot of the price at purchase time
  quantity      integer not null check (quantity between 1 and 20),
  size          text,
  check ((product_id is not null) <> (campaign_id is not null))
);

create index on public.orders (user_id);
create index on public.order_items (order_id);
create index on public.order_items (campaign_id);

-- 2) Joined count per preorder (only paid deposits count) ---------------
create view public.campaign_progress with (security_invoker = false) as
select c.id as campaign_id,
       coalesce(sum(oi.quantity) filter (where o.status = 'paid'), 0)::int as joined
from public.campaigns c
left join public.order_items oi on oi.campaign_id = c.id
left join public.orders o on o.id = oi.order_id
group by c.id;

-- 3) Security (Row Level Security) -------------------------------------
alter table public.products    enable row level security;
alter table public.campaigns   enable row level security;
alter table public.orders      enable row level security;
alter table public.order_items enable row level security;

create policy "anyone can read active products"
  on public.products for select using (active);
create policy "anyone can read active campaigns"
  on public.campaigns for select using (active);

create policy "users read their own orders"
  on public.orders for select using (auth.uid() = user_id);
create policy "users read their own order items"
  on public.order_items for select
  using (exists (select 1 from public.orders o
                 where o.id = order_id and o.user_id = auth.uid()));
-- No insert/update/delete policies on orders: the browser cannot write
-- orders directly. Orders are created only by create_order() below, and
-- marked 'paid' only by the payment webhook (service role, on the server).

-- Explicit access (Row Level Security above still decides which rows).
grant usage on schema public to anon, authenticated;
grant select on public.products, public.campaigns, public.campaign_progress
  to anon, authenticated;
grant select on public.orders, public.order_items to authenticated;

-- 4) Create an order with prices taken from the database ---------------
-- items example: [{"product_id":"<uuid>","quantity":2,"size":"M"},
--                 {"campaign_id":"<uuid>","quantity":1,"size":"L"}]
create or replace function public.create_order(items jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  new_order uuid;
  it jsonb;
  qty int;
  p public.products%rowtype;
  c public.campaigns%rowtype;
  total int := 0;
begin
  if uid is null then raise exception 'Sign in first'; end if;
  if jsonb_typeof(items) <> 'array' or jsonb_array_length(items) = 0 then
    raise exception 'Bag is empty';
  end if;

  insert into public.orders (user_id, total_thb) values (uid, 0) returning id into new_order;

  for it in select * from jsonb_array_elements(items) loop
    qty := coalesce((it->>'quantity')::int, 1);
    if qty < 1 or qty > 20 then raise exception 'Bad quantity'; end if;

    if it ? 'product_id' then
      select * into p from public.products
        where id = (it->>'product_id')::uuid and active and kind = 'ready';
      if not found then raise exception 'Product not available'; end if;
      insert into public.order_items (order_id, product_id, name, unit_price_thb, quantity, size)
        values (new_order, p.id, p.name, p.price_thb, qty, it->>'size');
      total := total + p.price_thb * qty;
    elsif it ? 'campaign_id' then
      select * into c from public.campaigns
        where id = (it->>'campaign_id')::uuid and active and ends_at > now();
      if not found then raise exception 'Preorder is closed'; end if;
      insert into public.order_items (order_id, campaign_id, name, unit_price_thb, quantity, size)
        values (new_order, c.id, c.title || ' (deposit)', c.deposit_thb, qty, it->>'size');
      total := total + c.deposit_thb * qty;
    else
      raise exception 'Bad item';
    end if;
  end loop;

  update public.orders set total_thb = total where id = new_order;
  return new_order;
end $$;

revoke all on function public.create_order(jsonb) from public, anon;
grant execute on function public.create_order(jsonb) to authenticated;

-- 5) Starter data (same items as the demo) -----------------------------
insert into public.products (slug, name, seller, price_thb, kind, categories, rating, sold_count) values
 ('teal-match-jersey',  'Teal Match Jersey · Edition 01',  'North Campus Studio', 890,  'ready',    '{jersey,ready}',    4.9, 120),
 ('rose-studio-jersey', 'Rose Studio Jersey · Founders Run','Arts Collective',    950,  'preorder', '{jersey,preorder}', null, 0),
 ('after-class-black',  'After Class Black Jersey',        'After Class Club',    990,  'ready',    '{jersey,ready}',    4.8, 74),
 ('canvas-studio-tote', 'Abstract Canvas Studio Tote',     'MakersBridge Editions',490, 'ready',    '{bag,ready}',       4.9, 210),
 ('brushstroke-tee',    'Brushstroke Creator Tee',         'Open Studio',         690,  'ready',    '{apparel,ready}',   4.7, 52),
 ('midnight-hoodie',    'Midnight Workshop Hoodie',        'Night Workshop',      1290, 'preorder', '{apparel,preorder}',null, 0);

insert into public.campaigns (product_id, title, seller, description, minimum, deposit_thb, ends_at)
select p.id, v.title, v.seller, v.descr, 50, 150, now() + v.days
from (values
  ('rose-studio-jersey',  'Rose Jersey',    'Arts Collective', 'Breathable mesh and an embroidered abstract crest.',               interval '8 days'),
  ('midnight-hoodie',     'Creator Hoodie', 'Night Workshop',  'A heavyweight hoodie based on an illustrator''s brushstroke collection.', interval '12 days')
) as v(slug, title, seller, descr, days)
join public.products p on p.slug = v.slug;

insert into public.campaigns (title, seller, description, minimum, deposit_thb, ends_at)
values ('Training Jersey', 'Common Ground', 'Team jersey with name and number options after the minimum is met.', 50, 150, now() + interval '5 days');
