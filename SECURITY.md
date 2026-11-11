# MakersBridge security

Status key: **Done** = in this repo and tested · **You** = a setting only the owner can change (dashboard) · **Later** = needed before real money moves.

## Report a problem
Use GitHub: *Security → Report a vulnerability* on this repo. Please do not post details publicly.

## OWASP Top 10 (2021)

| # | Risk | What we do | Status |
|---|------|-----------|--------|
| A01 | Broken access control | Row Level Security on every table. Customers see only their own orders. Admin rights live in a table the browser cannot read or write. `is_admin()` needs the user to be on that list **and** to have passed two-step verification (AAL2). Order status changes only through `admin_set_order_status()` with allowed steps. 99 attack-style tests cover anon, customer, other customer, admin without MFA and admin with MFA. | Done |
| A02 | Cryptographic failures | Passwords are hashed by Supabase Auth, never touched by our code. HTTPS only (GitHub Pages / custom domain). Only the public publishable key is in the page. | Done · **You**: turn on "Enforce HTTPS" in GitHub Pages |
| A03 | Injection | No string-built SQL anywhere. Data API uses parameters; `create_order()` validates every field (uuid pattern, quantity 1–20, size whitelist). The admin page writes database text with `textContent` only, so no HTML/JS can run (tested with a malicious name). | Done |
| A04 | Insecure design | Prices are read on the server, never from the browser. Preorder deposits only count when an admin marks the order paid. Limits: 5 pending orders per hour, 20 per day, 30 lines per order. Failed orders leave nothing behind (single transaction). | Done |
| A05 | Security misconfiguration | Least-privilege grants (anon can only read products and preorders). Strict Content Security Policy on the admin page; policy on the shop page. `_headers` for hosts that support headers (HSTS, frame-ancestors, nosniff, permissions). Admin page is `noindex` and `no-store`. | Done · **You**: see dashboard list below |
| A06 | Vulnerable components | One library (supabase-js), pinned to an exact version with an SRI hash, so a changed file will not run. Dependabot watches the GitHub Actions. | Done |
| A07 | Identification & auth failures | Email confirmation, 10+ character passwords, same message for "wrong email" and "wrong password", admin TOTP two-step verification, admin auto sign-out after 15 minutes idle, short-lived tokens. | Done · **You**: CAPTCHA + leaked-password check (below) |
| A08 | Software & data integrity | SRI on external scripts. CI fails if an external script has no integrity hash. Audit log is append-only (even the table owner cannot edit or delete rows). | Done · **You**: branch protection (below) |
| A09 | Logging & monitoring | Every product, preorder and order-status change is written to `audit_log` with who and what changed; visible in the admin page. | Done · **Later**: alerts on failed logins |
| A10 | Server-side request forgery | The site makes no server-side requests to user-supplied URLs. Product image links must start with `https://`. | Done |

## Extra protections beyond the Top 10
- **Clickjacking**: admin page hides itself inside any frame; `frame-ancestors 'none'` on hosts with headers.
- **XSS defence in depth**: Content Security Policy limits which scripts and servers the page may talk to.
- **Secret scanning in CI**: build fails if a `service_role` key, `sb_secret_` key or private key is committed, or if the admin code uses an HTML-injecting API.
- **Account enumeration**: sign-in errors are generic.
- **Error hygiene**: shoppers never see raw database errors.
- **Data minimisation (PDPA)**: orders store a user id, items and totals. No addresses, phone numbers or card data yet.
- **No hidden admin path**: admin rights are checked by the database on every request, not by hiding the page.
- **Open redirects**: sign-in return address is fixed to this site, and Supabase only allows addresses on its allow-list.

## Things only you can do (dashboard settings)
**Supabase → Authentication**
- [ ] URL Configuration: Site URL `https://jayvarmes.github.io/Business01/` and the same as an allowed Redirect URL
- [ ] Sign In / Providers → Email: keep **Confirm email** on; set minimum password length to **10** and require letters + numbers
- [ ] Attack Protection: turn on **CAPTCHA** (Cloudflare Turnstile is free) and, on the Pro plan, **leaked password protection**
- [ ] Rate Limits: keep the defaults or lower them
- [ ] Sessions: JWT expiry 3600 s or less; keep refresh-token reuse detection on
- [ ] Set up **custom SMTP** (for example Resend). The built-in email sender has a very small hourly limit, so real sign-ups would fail.
- [ ] Add your own account to the admin list (see `supabase/README.md`), then sign in at `/admin.html` and set up the authenticator app

**Supabase → Project settings**
- [ ] Data API: expose only the `public` schema; consider turning off GraphQL if you do not use it
- [ ] Database: strong password, "Enforce SSL" on, network restrictions if you only connect from known places
- [ ] **Backups**: the free plan has none. Upgrade to Pro before taking real orders.
- [ ] Turn on two-step verification on your Supabase, Google and GitHub accounts

**GitHub → Settings**
- [ ] Branches: protect `main` (require a pull request and passing checks)
- [ ] Code security: enable **Secret scanning** and **Push protection**, and Dependabot alerts
- [ ] Pages: enforce HTTPS
- [ ] Put the site behind Cloudflare (free) with your own domain for security headers, WAF and rate limiting; GitHub Pages cannot set headers itself

## Before real money (Later)
- Use a hosted payment page (PromptPay QR through Opn, 2C2P or Stripe). Never collect card numbers on this site.
- Mark orders paid only from a **signed payment webhook** (verify the signature, ignore repeats). Keep the `service_role` key only in the payment function's secrets, never in this repo or the page.
- Write a privacy policy and terms (PDPA): what you collect, why, how long you keep it, how to ask for deletion.
- Add refund and preorder-deadline rules, and a way for customers to contact you.
- Rehearse: restore a backup, remove an admin, rotate keys.
