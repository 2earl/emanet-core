# infra

Terraform for all of Emanet's Cloudflare resources (core and apps), in one HCP Terraform
workspace. Rationale: [docs/DESIGN.md §3](../docs/DESIGN.md).

| File | Manages |
|---|---|
| `storage.tf` | D1 `emanet` (core), `emanet-kurumsal`, `emanet-merkez` and `emanet-saha`; R2 bucket `emanet-evidence`. EU jurisdiction, protected from destroy |
| `worker.tf` | Custom domains `emanet-kurumsal`, `emanet-saha`, `emanet-merkez` `.2earl.com`, each switched on by a variable once its Worker exists |

Not managed here: the 2earl.com zone and its settings (2earl/login `infra/`), Worker code, Worker
secrets and D1 migrations (each repo's `.github/workflows/deploy.yml`).

The Cloudflare token needs: Account D1 edit, Account R2 Storage edit, and on the 2earl.com zone
Zone read and Workers Routes edit.

## How changes are applied

HCP Terraform (workspace `2earl-emanet-core`) keeps the state only; Terraform runs in GitHub Actions
(`.github/workflows/infra.yml`), so a run never depends on HCP fetching the repository.

1. Open a PR that changes files here. The `check` job runs `terraform fmt`, `init` and
   `validate`, without secrets.
2. Merge. On `main`, the `plan` job waits for the owner's approval (environment `production`),
   then writes the plan to the run's summary.
3. If there are changes, the `apply` job waits for a second approval and applies only if a fresh
   plan is identical to the one reviewed. Apply is never automatic.

Credentials, in the repository's `production` environment: `TF_API_TOKEN` (an HCP Terraform team
token) and `CLOUDFLARE_INFRA_API_TOKEN`. Nothing in this directory may contain a secret.

## First deployment

1. Merge. Approve the `infra` run's plan and then its apply: the databases and the bucket exist.
2. A PR puts `core_d1_database_id` into emanet-core's `wrangler.jsonc`, `kurumsal_d1_database_id`
   into emanet-kurumsal's and `merkez_d1_database_id` into emanet-merkez's. Merge; approve the
   `deploy` runs: core first, then Kurumsal and Merkez (they bind to the core).
3. A PR sets the defaults of `kurumsal_live` and `merkez_live` in `variables.tf` to `true`. Merge
   and approve the `infra` run: the two sites are attached. Later the same for `saha_live`.
