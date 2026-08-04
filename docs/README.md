# Documents

| File | What it is |
|---|---|
| `erd.mermaid` | 43 entities: identity, property, pricing, parking, messaging, scheduling, documents, leases |
| `schema-postgres.sql` | Postgres version with seed data. The SQLite schema the server runs is `server/src/schema.sql` |
| `ai-reply-architecture.zh-Hant.md` | How a tenant message is routed: hard stops, classification, fact lookup, drafting, then the rule that decides whether it sends |
| `improvement-backlog.zh-Hant.md` | Around forty open items, ordered by what matters |

The two Chinese documents were written for the manager rather than the
engineering team. Say the word and they can be translated.

## Viewing the ERD

GitHub renders `.mermaid` in the file view. Locally:

```bash
npx @mermaid-js/mermaid-cli -i docs/erd.mermaid -o erd.svg
```
