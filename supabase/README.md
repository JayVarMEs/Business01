# Database setup

Run these in **Supabase → SQL Editor**, in order:

1. `schema.sql` – tables, security rules, order function, starter data
2. `002_admin_security.sql` – admin side, audit log, stricter permissions and limits (safe to run again)

## Make yourself the first admin
1. Open the shop, create an account with your own email and confirm it.
2. In the SQL Editor run (replace the email; do not commit it):
   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'YOUR_EMAIL_HERE';
   ```
3. Open `/admin.html`, sign in, scan the QR code with an authenticator app, enter the 6-digit code.

Remove an admin: `delete from public.admins where user_id = '<uuid>';`
