# Emanet core

The data, rules and ledger behind Emanet, 2earl's service for creditors recovering vehicles that
carry an enforcement office's seizure order (*yakalama şerhi*). Three apps use it, each in its own
repository and at its own address:

| App | Repository | Address | Binds to |
| --- | --- | --- | --- |
| Emanet Kurumsal: creditors (banks, asset management companies) | 2earl/emanet-kurumsal | emanet-kurumsal.2earl.com | `PartnerApi` |
| Emanet Saha: field agents (web and mobile) | 2earl/emanet-saha | emanet-saha.2earl.com | `FieldApi` |
| Emanet Merkez: 2earl staff | 2earl/emanet-merkez | emanet-merkez.2earl.com | `ControlApi` |

The core itself has no address. Each app reaches only its own entrypoint over a Cloudflare Service
Binding, so the agents' app cannot, for example, confirm a delivery or read a creditor's cases.
People sign in to the apps with login.2earl.com.

Emanet is a private service, not a public authority. It finds vehicles and reports them; the
police seize them.

## What it does

- **Vehicles and cases** (`src/cases.ts`): one row per physical vehicle, identified by its VIN, with
  a plate history. Each creditor's claim on it is its own case. A creditor never learns that
  another creditor pursues the same vehicle.
- **Custom fields** (`src/fields.ts`): the extra columns each partner needs, defined as data and
  validated on every write.
- **Hunts and claims** (`src/claims.ts`): an agent claims a vehicle for a limited time and only
  then sees street addresses. Releasing it or letting it expire starts a cooldown. Sightings and
  photo evidence are recorded.
- **Money** (`src/ledger.ts`): delivery, invoices with KDV, receipts, payouts with dual approval.
  Everything goes through an immutable double-entry journal on the Turkish uniform chart of
  accounts.

Design: [docs/DESIGN.md](docs/DESIGN.md).

## Develop

```sh
pnpm install
pnpm test        # Workers runtime, real D1 with the migrations
pnpm typecheck
pnpm lint
```

Node.js 24, pnpm 10. Dependencies are at least a day old (`minimumReleaseAge`).

## Licence

Proprietary; see [LICENSE](LICENSE). The repository is public to read, not to reuse.
