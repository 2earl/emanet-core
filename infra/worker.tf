# The apps' addresses on emanet.dev. Cloudflare creates each DNS record and certificate itself.
# The Worker scripts are created by each app's deploy workflow, not by Terraform. emanet-core has
# no address.

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
  hostname   = "kurumsal.${var.zone_name}"
  service    = "emanet-kurumsal"
}

resource "cloudflare_workers_custom_domain" "saha" {
  count      = var.saha_live ? 1 : 0
  account_id = var.account_id
  zone_id    = data.cloudflare_zone.main.id
  hostname   = "saha.${var.zone_name}"
  service    = "emanet-saha"
}

resource "cloudflare_workers_custom_domain" "merkez" {
  count      = var.merkez_live ? 1 : 0
  account_id = var.account_id
  zone_id    = data.cloudflare_zone.main.id
  hostname   = "merkez.${var.zone_name}"
  service    = "emanet-merkez"
}

# The public site, at the apex: the front page for companies and agents, and the legal pages.
resource "cloudflare_workers_custom_domain" "web" {
  count      = var.web_live ? 1 : 0
  account_id = var.account_id
  zone_id    = data.cloudflare_zone.main.id
  hostname   = var.zone_name
  service    = "emanet-web"
}
