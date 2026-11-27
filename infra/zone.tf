# emanet.dev zone settings. The zone itself was created in the dashboard; it is read, never
# created or destroyed, here. Email (Cloudflare Email Service sending, iletisim@ routing) was set
# up in the dashboard too and is not touched.

locals {
  zone_settings = {
    ssl                      = "strict"
    min_tls_version          = "1.2"
    tls_1_3                  = "on"
    always_use_https         = "on"
    automatic_https_rewrites = "on"
    # 0-RTT lets a network attacker replay the first request of a resumed TLS session; the apps
    # take form posts and API writes.
    "0rtt" = "off"
    http3  = "on"
  }
}

resource "cloudflare_zone_setting" "this" {
  for_each = local.zone_settings

  zone_id    = data.cloudflare_zone.main.id
  setting_id = each.key
  value      = each.value
}

resource "cloudflare_zone_setting" "security_header" {
  zone_id    = data.cloudflare_zone.main.id
  setting_id = "security_header"
  value = {
    strict_transport_security = {
      enabled            = true
      max_age            = 31536000
      include_subdomains = true
      preload            = false
      nosniff            = true
    }
  }
}

# Banks call Kurumsal's API from their servers and webhook checks come from data centres: Bot
# Fight Mode would challenge them, and it can't be skipped per path. The apps rate-limit
# themselves (Workers Rate Limiting) and authenticate every call.
resource "cloudflare_bot_management" "this" {
  zone_id            = data.cloudflare_zone.main.id
  fight_mode         = false
  ai_bots_protection = "disabled"
}
