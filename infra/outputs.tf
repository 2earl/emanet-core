# IDs the Workers need in their wrangler.jsonc. None of these are secrets.

output "core_d1_database_id" {
  description = "emanet-core wrangler.jsonc → d1_databases[].database_id"
  value       = cloudflare_d1_database.core.id
}

output "kurumsal_d1_database_id" {
  description = "emanet-kurumsal wrangler.jsonc → d1_databases[].database_id"
  value       = cloudflare_d1_database.kurumsal.id
}

output "merkez_d1_database_id" {
  description = "emanet-merkez wrangler.jsonc → d1_databases[].database_id"
  value       = cloudflare_d1_database.merkez.id
}
