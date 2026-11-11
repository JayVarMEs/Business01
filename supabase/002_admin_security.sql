-- MakersBridge 002: admin side + security hardening (run AFTER schema.sql)
-- Safe to run more than once.
-- Run in: Supabase dashboard > SQL Editor > New query > paste > Run.
--
-- What this adds
--   * admins table (not reachable from the browser at all)
--   * is_admin(): true only for listed admins AND only when the session passed MFA (aal2)
--   * admin-only policies for products, campaigns, all orders, audit log
--   * audit log that nobody can edit or delete through the API
--   * order status changes only through admin_set_order_status() with allowed steps
--   * stricter table/function privileges (least privilege)
--   * input limits (lengths, https-only image links, size whitelist, price caps)
--   * order rate limits and stricter create_order()
-- ---------------------------------------------------------------------------

begin;

-- 1) Admin registry --------------------------------------------------------
create table if not exists public.admins (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);
alter table public.admins enable row level security;
-- No policies on purpose: the browser can never read or change this table.

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public, auth
as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid())
     and coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
$$;

-- 'none' | 'needs_mfa' | 'admin'  (only ever describes the caller themself)
create or replace function public.admin_status()
returns text
language sql stable security definer
set search_path = public, auth
as $$
  select case
    when not exists (select 1 from public.admins where user_id = auth.uid()) then 'none'
    when coalesce(auth.jwt() ->> 'aal', '') = 'aal2' then 'admin'
    else 'needs_mfa'
  end;
$$;

-- 2) Audit log (append-only) ----------------------------------------------
create table if not exists public.audit_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor      uuid,
  action     text not null,
  table_name text,
  row_id     text,
  old_data   jsonb,
  new_data   jsonb
);
alter table public.audit_log enable row level security;
drop policy if exists "admins read audit log" on public.audit_log;
create policy "admins read audit log" on public.audit_log
  for select to authenticated using (public.is_admin());

create or replace function public.audit_block_changes()
returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only';
end $$;
drop trigger if exists audit_log_no_update on public.audit_log;
create trigger audit_log_no_update before update or delete on public.audit_log
  for each row execute function public.audit_block_changes();

create or replace function public.audit_row()
returns trigger
language plpgsql security definer
set search_path = public, auth
as $$
begin
  insert into public.audit_log (actor, action, table_name, row_id, old_data, new_data)
  values (
    auth.uid(), tg_op, tg_table_name,
    coalesce((case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end) ->> 'id', ''),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
  );
  return null;
end $$;

drop trigger if exists audit_products on public.products;
create trigger audit_products after insert or update or delete on public.products
  for each row execute function public.audit_row();
drop trigger if exists audit_campaigns on public.campaigns;
create trigger audit_campaigns after insert or update or delete on public.campaigns
  for each row execute function public.audit_row();

-- 3) Admin policies (all require is_admin(), which requires MFA) -----------
drop policy if exists "admins manage products" on public.products;
create policy "admins manage products" on public.products
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admins manage campaigns" on public.campaigns;
create policy "admins manage campaigns" on public.campaigns
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admins read all orders" on public.orders;
create policy "admins read all orders" on public.orders
  for select to authenticated using (public.is_admin());

drop policy if exists "admins read all order items" on public.order_items;
create policy "admins read all order items" on public.order_items
  for select to authenticated using (public.is_admin());

-- 4) Input limits ---------------------------------------------------------
alter table public.products drop constraint if exists products_name_len;
alter table public.products drop constraint if exists products_seller_len;
alter table public.products drop constraint if exists products_slug_fmt;
alter table public.products drop constraint if exists products_price_max;
alter table public.products drop constraint if exists products_image_https;
alter table public.products drop constraint if exists products_rating_range;
alter table public.products
  add constraint products_name_len    check (char_length(name) between 1 and 120),
  add constraint products_seller_len  check (char_length(seller) between 1 and 80),
  add constraint products_slug_fmt    check (slug ~ '^[a-z0-9-]{1,80}$'),
  add constraint products_price_max   check (price_thb <= 100000),
  add constraint products_image_https check (image_url is null or image_url ~ '^https://'),
  add constraint products_rating_range check (rating is null or rating between 0 and 5);

alter table public.campaigns drop constraint if exists campaigns_title_len;
alter table public.campaigns drop constraint if exists campaigns_seller_len;
alter table public.campaigns drop constraint if exists campaigns_desc_len;
alter table public.campaigns drop constraint if exists campaigns_caps;
alter table public.campaigns
  add constraint campaigns_title_len  check (char_length(title) between 1 and 120),
  add constraint campaigns_seller_len check (char_length(seller) between 1 and 80),
  add constraint campaigns_desc_len   check (description is null or char_length(description) <= 500),
  add constraint campaigns_caps       check (minimum <= 100000 and deposit_thb <= 100000);

alter table public.order_items drop constraint if exists order_items_size_ok;
alter table public.order_items drop constraint if exists order_items_name_len;
alter table public.order_items
  add constraint order_items_size_ok  check (size is null or size in ('XS','S','M','L','XL','XXL')),
  add constraint order_items_name_len check (char_length(name) <= 200);

alter table public.orders drop constraint if exists orders_total_cap;
alter table public.orders add constraint orders_total_cap check (total_thb <= 500000);

-- 5) Orders: stricter create_order(), customer cancel, admin tools --------
create or replace function public.create_order(items jsonb)
returns uuid
language plpgsql security definer
set search_path = public, auth
as $$
declare
  uid uuid := auth.uid();
  new_order uuid;
  it jsonb;
  qty int;
  sz text;
  p public.products%rowtype;
  c public.campaigns%rowtype;
  total int := 0;
  uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if uid is null then raise exception 'Sign in first' using errcode = '42501'; end if;

  if jsonb_typeof(items) is distinct from 'array' then raise exception 'Bad bag'; end if;
  if jsonb_array_length(items) < 1 or jsonb_array_length(items) > 30 then
    raise exception 'Bag must have 1 to 30 lines';
  end if;

  -- abuse limits
  if (select count(*) from public.orders
        where user_id = uid and status = 'pending' and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'Too many pending orders. Please try again later.';
  end if;
  if (select count(*) from public.orders
        where user_id = uid and created_at > now() - interval '1 day') >= 20 then
    raise exception 'Daily order limit reached.';
  end if;

  insert into public.orders (user_id, total_thb) values (uid, 0) returning id into new_order;

  for it in select * from jsonb_array_elements(items) loop
    if jsonb_typeof(it) is distinct from 'object' then raise exception 'Bad item'; end if;
    if (it ? 'product_id') = (it ? 'campaign_id') then raise exception 'Bad item'; end if;

    if coalesce(it ->> 'quantity', '1') !~ '^[0-9]{1,2}$' then raise exception 'Bad quantity'; end if;
    qty := coalesce((it ->> 'quantity')::int, 1);
    if qty < 1 or qty > 20 then raise exception 'Bad quantity'; end if;

    sz := it ->> 'size';
    if sz is not null and sz not in ('XS','S','M','L','XL','XXL') then raise exception 'Bad size'; end if;

    if it ? 'product_id' then
      if (it ->> 'product_id') !~* uuid_re then raise exception 'Bad item'; end if;
      select * into p from public.products
        where id = (it ->> 'product_id')::uuid and active and kind = 'ready';
      if not found then raise exception 'Product not available'; end if;
      insert into public.order_items (order_id, product_id, name, unit_price_thb, quantity, size)
        values (new_order, p.id, p.name, p.price_thb, qty, sz);
      total := total + p.price_thb * qty;
    else
      if (it ->> 'campaign_id') !~* uuid_re then raise exception 'Bad item'; end if;
      select * into c from public.campaigns
        where id = (it ->> 'campaign_id')::uuid and active and ends_at > now();
      if not found then raise exception 'Preorder is closed'; end if;
      insert into public.order_items (order_id, campaign_id, name, unit_price_thb, quantity, size)
        values (new_order, c.id, left(c.title || ' (deposit)', 200), c.deposit_thb, qty, sz);
      total := total + c.deposit_thb * qty;
    end if;
  end loop;

  update public.orders set total_thb = total where id = new_order;
  return new_order;
end $$;

create or replace function public.cancel_my_order(p_order uuid)
returns void
language plpgsql security definer
set search_path = public, auth
as $$
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  update public.orders set status = 'cancelled'
    where id = p_order and user_id = auth.uid() and status = 'pending';
  if not found then raise exception 'This order cannot be cancelled'; end if;
end $$;

create or replace function public.admin_set_order_status(p_order uuid, p_status text)
returns void
language plpgsql security definer
set search_path = public, auth
as $$
declare cur text;
begin
  if not public.is_admin() then raise exception 'Not allowed' using errcode = '42501'; end if;
  select status into cur from public.orders where id = p_order for update;
  if cur is null then raise exception 'Order not found'; end if;
  if not ((cur = 'pending' and p_status in ('paid', 'cancelled'))
       or (cur = 'paid' and p_status = 'refunded')) then
    raise exception 'Cannot change % to %', cur, p_status;
  end if;
  update public.orders set status = p_status where id = p_order;
  insert into public.audit_log (actor, action, table_name, row_id, old_data, new_data)
  values (auth.uid(), 'STATUS', 'orders', p_order::text,
          jsonb_build_object('status', cur), jsonb_build_object('status', p_status));
end $$;

create or replace function public.admin_list_orders(p_limit int default 50)
returns table (id uuid, created_at timestamptz, status text, total_thb int, email text, items jsonb)
language plpgsql stable security definer
set search_path = public, auth
as $$
begin
  if not public.is_admin() then raise exception 'Not allowed' using errcode = '42501'; end if;
  return query
    select o.id, o.created_at, o.status, o.total_thb, u.email::text,
           coalesce((select jsonb_agg(jsonb_build_object(
                       'name', oi.name, 'qty', oi.quantity,
                       'price', oi.unit_price_thb, 'size', oi.size))
                     from public.order_items oi where oi.order_id = o.id), '[]'::jsonb)
    from public.orders o
    join auth.users u on u.id = o.user_id
    order by o.created_at desc
    limit least(greatest(p_limit, 1), 200);
end $$;

-- 6) Least-privilege grants (RLS still decides which rows) ------------------
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from public, anon, authenticated;

grant usage on schema public to anon, authenticated;

grant select on public.products, public.campaigns, public.campaign_progress to anon, authenticated;
grant select on public.orders, public.order_items, public.audit_log          to authenticated;
-- write access for admins only (the policies above require is_admin())
grant insert, update, delete on public.products, public.campaigns to authenticated;

grant execute on function
  public.is_admin(),
  public.admin_status(),
  public.create_order(jsonb),
  public.cancel_my_order(uuid),
  public.admin_set_order_status(uuid, text),
  public.admin_list_orders(int)
to authenticated;

commit;

-- ---------------------------------------------------------------------------
-- MAKE YOURSELF THE FIRST ADMIN (run once, separately, after you have signed up
-- on the site with your own email). Replace the email. Do NOT commit your email.
--
--   insert into public.admins (user_id)
--   select id from auth.users where email = 'YOUR_EMAIL_HERE';
--
-- To remove an admin:  delete from public.admins where user_id = '<uuid>';
-- ---------------------------------------------------------------------------
