variable "account_id" {
  description = "Cloudflare account that owns the 2earl Workers. Service Bindings reach only Workers in the same account."
  type        = string
  # Cloudflare account IDs are identifiers, not credentials.
  default = "304c2b77d734c688c8309d5a535f561a"
}

variable "zone_name" {
  description = "Emanet's own zone: the public site at the apex, each app one level deep (<app>.emanet.dev)."
  type        = string
  default     = "emanet.dev"
}

# An app's custom domain can only attach once its Worker exists: set each to true after the app's
# first deploy (README, First deployment).
variable "kurumsal_live" {
  description = "Attach kurumsal.emanet.dev to the emanet-kurumsal Worker."
  type        = bool
  default     = true
}

variable "saha_live" {
  description = "Attach saha.emanet.dev to the emanet-saha Worker."
  type        = bool
  default     = true
}

variable "merkez_live" {
  description = "Attach merkez.emanet.dev to the emanet-merkez Worker."
  type        = bool
  default     = true
}

variable "web_live" {
  description = "Attach emanet.dev to the emanet-web Worker (2earl/emanet-web), after its first deploy."
  type        = bool
  default     = false
}
