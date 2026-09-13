/**
 * monitoring.tf — uptime + log-based alerts (docs/08 §8.8, docs/07 §7.7).
 *
 * Everything here depends on log data actually reaching Cloud Logging from a
 * plain GCE VM, which needs the Ops Agent — infra/vm/bootstrap.sh installs
 * `google-cloud-ops-agent` with its default config, which ships journald
 * (i.e. anything the two systemd units write to stdout/stderr — that's
 * where pino prints structured JSON logs, since ExecStart runs `node`
 * directly with no redirection). No custom Ops Agent receiver config is
 * needed for that default path.
 *
 * VERIFY-LIVE (infra): the log filters below match on a bare substring
 * (`:` contains) of `textPayload`, which is robust whether or not the
 * pino JSON line ends up parsed into `jsonPayload` fields by the default
 * receiver. Once real logs are flowing (Phase 1), check the actual entry
 * shape in Logs Explorer and tighten these to `jsonPayload.err:"..."` /
 * `jsonPayload.kind="..."` if that's cleaner.
 */

resource "google_monitoring_notification_channel" "email" {
  project      = var.project_id
  display_name = "Portfolio manager alerts"
  type         = "email"

  labels = {
    email_address = var.alert_email
  }
}

# docs/08 §8.8: "Uptime check on /v1/health" — the actual route the backend
# serves is `/health` (apps/backend/src/http/app.ts: `app.get('/health', ...)`,
# `PUBLIC_PATHS = new Set(['/health'])`), not `/v1/health`; every other route
# is under `/v1/*` and requires auth. This check hits the public HTTPS name
# (Caddy terminates TLS on 443 and reverse-proxies to the backend's
# `config.port`, default 8080, on 127.0.0.1 only).
resource "google_monitoring_uptime_check_config" "backend_health" {
  project      = var.project_id
  display_name = "pm-backend /health"
  timeout      = "10s"
  period       = "60s"

  http_check {
    path         = "/health"
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = var.domain
    }
  }

  depends_on = [google_project_service.this]
}

resource "google_monitoring_alert_policy" "backend_down" {
  project      = var.project_id
  display_name = "pm-backend down (uptime check failing)"
  combiner     = "OR"

  conditions {
    display_name = "/health check failing"
    condition_threshold {
      filter          = "resource.type=\"uptime_url\" AND metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.label.\"check_id\"=\"${google_monitoring_uptime_check_config.backend_health.uptime_check_id}\""
      comparison      = "COMPARISON_LT"
      threshold_value = 1
      duration        = "180s"

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_FRACTION_TRUE"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.host"]
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]

  documentation {
    content   = "docs/08 §8.8: fail-closed means no orders while the backend is down — treat this as urgent, not routine. Incident playbook: infra/README.md#incident-playbook."
    mime_type = "text/markdown"
  }
}

locals {
  log_metrics = {
    ip_not_whitelisted = {
      description = "Broker rejected a call because the VM's egress IP isn't whitelisted (docs/07 §7.7) — SEBI static-IP mandate violation risk."
      filter      = "resource.type=\"gce_instance\" AND textPayload:\"IP_NOT_WHITELISTED\""
    }
    auth_expired = {
      description = "Broker session/token expired mid-operation (docs/07 §7.7: alert on bursts, not a single occurrence — a session naturally expires ~daily)."
      filter      = "resource.type=\"gce_instance\" AND textPayload:\"AUTH_EXPIRED\""
    }
    order_failed = {
      description = "An `order.failed` audit event was logged (packages/core AuditEventType) — a placed order the broker rejected or errored."
      filter      = "resource.type=\"gce_instance\" AND textPayload:\"order.failed\""
    }
    backend_fatal_crash = {
      description = "pm-backend's composition root failed to start (apps/backend/src/index.ts writes `fatal: ...` to stderr and exits 1) — complements the uptime check with a faster, log-based signal."
      filter      = "resource.type=\"gce_instance\" AND textPayload:\"fatal:\""
    }
  }
}

resource "google_logging_metric" "this" {
  for_each = local.log_metrics

  project     = var.project_id
  name        = "pm-${replace(each.key, "_", "-")}"
  description = each.value.description
  filter      = each.value.filter

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

# IP_NOT_WHITELISTED and a fatal crash: alert on the very first occurrence.
resource "google_monitoring_alert_policy" "immediate" {
  for_each = toset(["ip_not_whitelisted", "backend_fatal_crash", "order_failed"])

  project      = var.project_id
  display_name = "pm-${replace(each.value, "_", "-")}"
  combiner     = "OR"

  conditions {
    display_name = "any occurrence in 5m"
    condition_threshold {
      filter          = "resource.type=\"gce_instance\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.this[each.value].name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_COUNT"
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]
}

# AUTH_EXPIRED: alert on a BURST (>= 3 in 5 minutes), not the first
# occurrence — docs/07 §7.7 distinguishes this explicitly because a broker
# session expires ~daily by design (docs/07 §7.6) and that alone is not an
# incident.
resource "google_monitoring_alert_policy" "auth_expired_burst" {
  project      = var.project_id
  display_name = "pm-auth-expired-burst"
  combiner     = "OR"

  conditions {
    display_name = ">= 3 AUTH_EXPIRED in 5m"
    condition_threshold {
      filter          = "resource.type=\"gce_instance\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.this["auth_expired"].name}\""
      comparison      = "COMPARISON_GTE"
      threshold_value = 3
      duration        = "0s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_COUNT"
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]
}
