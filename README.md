# Glenride System Map — standalone rebuild

Independent rebuild of the Muse `glenride-system-map` artifact, live at
**https://map.dvaughnhouse.org**. The Muse original stays live and untouched;
this is a rebuild, not a migration.

## Hosting

- **Worker** `glenride-system-map-api` — API + password gate, `workers_dev = true`.
  The SPA calls it at its `*.workers.dev` URL (see `public/config.js`).
- **Pages** `glenride-system-map` — static SPA frontend, custom domain
  `map.dvaughnhouse.org` (Pages creates the DNS).
- **D1** shared database `glenride-hq` (`0d78cc19-3b11-4f39-805e-c061524cab2f`) —
  the account hit the 10-database system limit, so no new D1 database could be
  created. This app owns ONLY the `sysmap_*` tables and never touches `hq_*`
  (Glenride HQ's tables in the same database).

## Auth

Password gate (the original was a private artifact; org structure and budgets
are internal). `POST /api/login` with the password mints an HMAC session token
(30 days), returned in JSON and set as an HttpOnly cookie. All other API
routes return 401 without a valid token (Bearer or cookie). The password lives
only as the Worker secret `APP_PASSWORD` — never in this repo.

## Data

Seeded verbatim from `muse-backup-2026-11-08/glenride-system-map/data-snapshot-getmap.json`
(see `migrations/0001_init.sql`, generated from that snapshot):

- 7 departments (title, tagline, mandate, cost_center, current_state,
  future_state, done_looks_like, accent, is_core, sort_order)
- 5 budget stages: Plan, Raise & deploy, Allocate, Execute, Reallocate
- 5-level hierarchy (Founder & Interim President → Lead Director →
  Department Directors → Managers → Teams)
- Org premise: "An independent research institute with a venture studio inside.
  Research earns the credibility; products fund the research."

## API

All routes except `/api/health` and `/api/login` require auth.

- `GET /api/map` — full map (the original `getmap`)
- `POST /api/departments` / `PATCH /api/departments/:id` / `DELETE /api/departments/:id`
- `PATCH /api/budget-stages/:id`, `PATCH /api/hierarchy/:id`, `PATCH /api/organization`
- `POST /api/action` `{action, ...}` — original Muse action names:
  `getmap`, `adddepartment`, `updatedepartment`, `deletedepartment`,
  `updatebudgetstage`, `updatehierarchycard`, `updateorganization`

## Also on this subdomain

`public/free-will-machine.html` — the separate static `system-map` export
("The Free-Will Machine": 9 mechanisms, 12 relations, 15 project forecasts),
re-hosted verbatim. It shares no content with the System Map app; it is a
distinct interactive study, kept as a static page under the same subdomain
rather than a second app.

## Deploy

```bash
export PATH=~/workspace/.npm-global/bin:$PATH
# Worker (needs CLOUDFLARE_API_TOKEN; see pages_wrangler_deploy.py for the
# surrogate mechanism, or use /tmp/cf-run.py)
wrangler deploy
# Pages (from inside public/)
python3 ~/workspace/custom-connectors/custom.legacy-cloudflare/bin/pages_wrangler_deploy.py \
  --project glenride-system-map --dir ~/workspace/repos/glenride-system-map/public
# D1 migration
wrangler d1 execute glenride-hq --remote --file migrations/0001_init.sql
# Password (never commit; set once, rotate via the same command)
echo "<password>" | wrangler secret put APP_PASSWORD
```
