# The apps' addresses. Cloudflare creates each DNS record and certificate itself. The Worker
# scripts are created by each app's deploy workflow, not by Terraform. emanet-core has no address.

data "cloudflare_zone" "main" {
  filter = {
    name    = var.zone_name
    account = { id = var.account_id }
  }
}

resource "cloudflare_workers_custom_domain" "kurumsal" {
  count      = var.kurumsal_live ? 1 : 0
  account_id = var.account_id
  zone_id    = data.cloudflare_zone.main.id
  hostname   = "emanet-kurumsal.${var.zone_name}"
  service    = "emanet-kurumsal"
}

resource "cloudflare_workers_custom_domain" "saha" {
  count      = var.saha_live ? 1 : 0
  account_id = var.account_id
  zone_id    = data.cloudflare_zone.main.id
  hostname   = "emanet-saha.${var.zone_name}"
  service    = "emanet-saha"
}

resource "cloudflare_workers_custom_domain" "merkez" {
  count      = var.merkez_live ? 1 : 0
  account_id = var.account_id
  zone_id    = data.cloudflare_zone.main.id
  hostname   = "emanet-merkez.${var.zone_name}"
  service    = "emanet-merkez"
}
