# infra

Terraform for all of Emanet's Cloudflare resources (core and apps), in one HCP Terraform
workspace. Rationale: [docs/DESIGN.md §3](../docs/DESIGN.md).

| File | Manages |
|---|---|
| `storage.tf` | D1 `emanet` (core) and `emanet-kurumsal`; R2 bucket `emanet-evidence`. EU jurisdiction, protected from destroy |
| `worker.tf` | Custom domains `emanet-kurumsal`, `emanet-saha`, `emanet-merkez` `.2earl.com`, each switched on by a variable once its Worker exists |

Not managed here: the 2earl.com zone and its settings (2earl/login `infra/`), Worker code, Worker
secrets and D1 migrations (each repo's `.github/workflows/deploy.yml`).

The Cloudflare token needs: Account D1 edit, Account R2 Storage edit, and on the 2earl.com zone
Zone read and Workers Routes edit.

## How changes are applied

1. A PR that changes files here gets a speculative plan from HCP Terraform (workspace
   `2earl-emanet`, working directory `infra`).
2. Merge. HCP queues a run on `main`.
3. The owner reviews the plan in HCP and confirms the apply. Apply is never automatic.

Credentials: `CLOUDFLARE_API_TOKEN` is a sensitive **environment** variable in the workspace (not a
Terraform variable). Nothing in this directory may contain a secret.

## First deployment

1. Create the HCP workspace `2earl-emanet` (VCS: 2earl/emanet-core, working directory `infra`,
   manual apply) with `CLOUDFLARE_API_TOKEN`. Merge, confirm the apply: the databases and the
   bucket exist.
2. A PR puts `core_d1_database_id` into emanet-core's `wrangler.jsonc` and
   `kurumsal_d1_database_id` into emanet-kurumsal's. Merge; approve the `deploy` runs: core first,
   then Kurumsal (it binds to the core).
3. Set the workspace variable `kurumsal_live = true` and apply: emanet-kurumsal.2earl.com is
   attached. Later the same for `saha_live` and `merkez_live`.
