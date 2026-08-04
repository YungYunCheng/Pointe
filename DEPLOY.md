# Deployment

Three containers on one network. Only the web container is published; the API
and the database are reachable inside the Docker network only.

```
                 ┌──────────┐
  browser ──────▶│   web    │  nginx, port 8080
                 │  (nginx) │  serves the built app, proxies /api
                 └────┬─────┘
                      │  http://api:4000
                 ┌────▼─────┐
                 │   api    │  Node, port 4000, not published
                 │  (node)  │  permissions, audit, locks, concurrency
                 └────┬─────┘
                      │  postgres://db:5432
                 ┌────▼─────┐
                 │    db    │  Postgres 16, not published
                 │(postgres)│  volume: db-data
                 └──────────┘
```

---

## Running it

```bash
cp .env.example .env
openssl rand -base64 32          # paste into POSTGRES_PASSWORD
docker compose up -d --build
```

Open http://localhost:8080 and sign in as `admin@themizar.ca`.

**Change all three seed passwords immediately.** They were shared over chat and
every account is flagged `must_change_password`.

### Development

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

Source is mounted, both servers reload on save, and the API and database ports
are published so you can curl one and point a GUI client at the other.

---

## What goes where

| Directory | Container | Contains |
|---|---|---|
| `web/` | web | Vite app, nginx config, the eleven tools |
| `server/` | api | Express routes, permission matrix, jobs |
| `infra/postgres/init/` | db | Schema, run once when the volume is empty |
| `docs/`, `data/` | — | Reference only, not copied into any image |

---

## Why the ports look like this

**Only web publishes.** A Postgres port published to the host is how databases
end up scanned and compromised. To reach it:

```bash
docker compose exec db psql -U baydo -d baydo
```

**nginx proxies `/api` rather than the browser calling the API directly.**
Everything is same-origin, so there are no CORS headers to get wrong and no
preflight requests. `VITE_API_URL` stays empty in production for this reason.

**`VITE_API_URL` is a build arg, not an environment variable.** Vite inlines it
at build time. Setting it at runtime does nothing, which is a confusing hour to
lose.

---

## Volumes

| Volume | Holds | If you lose it |
|---|---|---|
| `db-data` | Every unit, lease, lead, allocation, audit entry | Everything |
| `api-data` | Evidence files and database backups | The proof behind every deposit deduction |

Both belong in your backup routine. The evidence volume matters more than it
looks: a deduction the tenant disputes is defended with the photos in there.

```bash
# Database
docker compose exec db pg_dump -U baydo baydo | gzip > backup-$(date +%F).sql.gz

# Evidence and backups
docker run --rm -v baydo-pointe_api-data:/data -v "$PWD":/out alpine \
  tar czf /out/evidence-$(date +%F).tar.gz -C /data .
```

---

## Before this faces the internet

**TLS.** Put Caddy or Traefik in front, or terminate at a load balancer. Session
cookies are set `secure` when `NODE_ENV=production`, so they will not be sent
over plain HTTP and sign-in will appear to fail silently.

**Postgres.** The server currently runs SQLite. `docs/schema-postgres.sql` is
written and the compose file is wired for Postgres, but `server/src/db.js` still
opens SQLite — swap the driver and change the immediate transaction to
`SELECT ... FOR UPDATE`. Everything else carries over.

**Password hashing.** scrypt today, Argon2id before production.

**Evidence to object storage.** Local disk does not survive a container being
replaced on another host.

**Log shipping.** Container logs vanish with the container. The audit table is
in Postgres and survives, but application logs do not.

---

## Sizing

330 units and a handful of staff is small. A single 2 GB host runs all three
comfortably. Postgres is the only one that grows: audit entries and messages
accumulate, so partition the audit table by month once it gets large.

---

## Health checks

```bash
curl http://localhost:8080/health          # nginx
docker compose exec api curl -fsS localhost:4000/health
docker compose ps                          # all three should read healthy
```

If `api` restarts in a loop, it is almost always the database password: the API
starts before Postgres finishes initialising on the very first run, and
`depends_on: condition: service_healthy` handles that — but a wrong password
looks identical. Check with `docker compose logs api`.
