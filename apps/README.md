# Front end

Self-contained React components. Each one holds its own styles, so any of them
can be dropped into a project and rendered without further setup.

```
staff/src/tools/   Internal tools. English only.
tenant/src/        Public chat widget. Bilingual, follows the tenant.
```

## Shared state

The tools talk to each other through browser storage keys, which is what makes
them work together in a review environment:

| Key | Written by | Read by |
|---|---|---|
| `baydo:session` | AuthConsole | every tool |
| `baydo:pricing` | LeasingConsole | LeaseIntake, AiInbox, TenantChat |
| `baydo:overrides` | LeasingConsole | Operations, AiInbox, TenantChat |
| `baydo:parking` | LeasingConsole | Operations, LeaseIntake, TenantChat |
| `baydo:schedule` | Schedule | BuildingManager, LeadsCrm, Operations |
| `baydo:leads` | LeadsCrm | Operations |
| `baydo:moveouts` | Operations | BuildingManager |
| `baydo:maintenance` | BuildingManager | — |
| `baydo:doclib` / `baydo:docinst` | Documents | — |
| `baydo:agentqueue` | LeaseIntake | Documents |
| `baydo:unitlocks` | LeaseIntake | LeaseIntake |

**Replace these with API calls before shipping.** Browser storage means anyone
with developer tools can rewrite pricing, roles and lock state. The endpoints
that replace each key are in `server/README.md`.

## Order to review them in

1. `AuthConsole` — sign in as Admin first
2. `LeasingConsole` — set rents, or everything downstream shows "not set"
3. Whichever tool you are working on
