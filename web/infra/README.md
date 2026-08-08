# Infrastructure

```
postgres/init/    Runs once, when the db volume is empty
nginx/            Reserved for a TLS-terminating reverse proxy
```

## Postgres init

`01-schema.sql` creates every table and seeds the buildings, unit types, parking
areas and roles. It runs **only when `db-data` is empty**. Editing it afterwards
does nothing.

To re-run it during development:

```bash
docker compose down -v      # deletes the volume and everything in it
docker compose up -d
```

For a live database, write a migration instead.

## TLS

Nothing here yet. Put Caddy or Traefik in front of the web container, or
terminate at a load balancer. Session cookies are `secure` in production, so
without TLS sign-in fails in a way that looks like a wrong password.
