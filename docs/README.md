# Documents

| File | What it is |
|---|---|
| `STATUS.md` | Every function, what the AI does and does not do, and the gaps in order |
| `STATUS.zh-Hant.md` | The same document in Chinese, for the manager |
| `REPORT.zh-Hant.md` | Full written report: every module, who uses it, what the AI does, and what is missing |
| `STATUS-v2.zh-Hant.md` | Second pass, after accounting and the gap closures |
| `ACCOUNTING.md` | Double entry, deposits in trust, amendments, the close |
| `OPERATIONS-GAPS.md` | What was built for each item raised against the first inventory |
| `AGREEMENTS.md` | Why agreements are uploaded rather than generated |
| `WIRING.md` | Connecting the front end to the API |
| `STATUS.zh-Hant.md` | The same inventory in Chinese, for the manager |
| `inventory-and-gaps.md` | Everything built, what the AI does, and what is missing — start here |
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
