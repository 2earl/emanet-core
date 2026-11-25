# Emanet's data (docs/DESIGN.md §3, §8). EU jurisdiction, chosen at creation and unchangeable, until
# the pilot partner rules on hosting in Turkey (§0.5, §11.2).
#
# prevent_destroy: replacing any of these deletes cases, claims, evidence or the books. If a plan
# ever wants to replace one, stop and investigate instead of removing the guard.

# The core: partners, vehicles, cases, agents, claims, the ledger.
resource "cloudflare_d1_database" "core" {
  account_id   = var.account_id
  name         = "emanet"
  jurisdiction = "eu"

  # Read replicas outside the EU would defeat the jurisdiction choice.
  read_replication = {
    mode = "disabled"
  }

  lifecycle {
    prevent_destroy = true
  }
}

# Emanet Kurumsal's own: sign-in sessions, API keys (HMACs), webhooks, delivery log.
resource "cloudflare_d1_database" "kurumsal" {
  account_id   = var.account_id
  name         = "emanet-kurumsal"
  jurisdiction = "eu"

  read_replication = {
    mode = "disabled"
  }

  lifecycle {
    prevent_destroy = true
  }
}

# Emanet Merkez's own: staff sign-in sessions only.
resource "cloudflare_d1_database" "merkez" {
  account_id   = var.account_id
  name         = "emanet-merkez"
  jurisdiction = "eu"

  read_replication = {
    mode = "disabled"
  }

  lifecycle {
    prevent_destroy = true
  }
}

# Agents' photos and the police, tow and custody documents (DESIGN §3 "Files"). Never public:
# no custom domain, no r2.dev access; served through the apps only.
resource "cloudflare_r2_bucket" "evidence" {
  account_id   = var.account_id
  name         = "emanet-evidence"
  jurisdiction = "eu"

  lifecycle {
    prevent_destroy = true
  }
}
