variable "account_id" {
  description = "Cloudflare account that owns the 2earl Workers. Service Bindings reach only Workers in the same account."
  type        = string
  # Cloudflare account IDs are identifiers, not credentials.
  default = "304c2b77d734c688c8309d5a535f561a"
}

variable "zone_name" {
  description = "The zone the Emanet apps are served under, one level deep (emanet-<app>.2earl.com)."
  type        = string
  default     = "2earl.com"
}

# An app's custom domain can only attach once its Worker exists: set each to true after the app's
# first deploy (README, First deployment).
variable "kurumsal_live" {
  description = "Attach emanet-kurumsal.2earl.com to the emanet-kurumsal Worker."
  type        = bool
  default     = true
}

variable "saha_live" {
  description = "Attach emanet-saha.2earl.com to the emanet-saha Worker."
  type        = bool
  default     = true
}

variable "merkez_live" {
  description = "Attach emanet-merkez.2earl.com to the emanet-merkez Worker."
  type        = bool
  default     = true
}
