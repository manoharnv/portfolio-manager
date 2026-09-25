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
#
# ALWAYS-ON MODE (the default, `vm_schedule_enabled = false`). In the optional scheduled
# mode the VM is intentionally off ~15 h/day, so a 24/7 uptime check would
# page every evening and train you to ignore it — see `window_health` below.
resource "google_monitoring_uptime_check_config" "backend_health" {
  count = var.vm_schedule_enabled ? 0 : 1

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
  count = var.vm_schedule_enabled ? 0 : 1

  project      = var.project_id
  display_name = "pm-backend down (uptime check failing)"
  combiner     = "OR"

  conditions {
    display_name = "/health check failing"
    condition_threshold {
      filter = "resource.type=\"uptime_url\" AND metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.label.\"check_id\"=\"${google_monitoring_uptime_check_config.backend_health[0].uptime_check_id}\""
      # Google's documented uptime-check alert shape: count the checker
      # locations reporting FALSE (ALIGN_NEXT_OLDER keeps the BOOL value, so
      # REDUCE_COUNT_FALSE is valid — ALIGN_FRACTION_TRUE would turn it into a
      # DOUBLE and the API rejects the reducer) and fire when more than one
      # location fails for 60 s.
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "60s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.*"]
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

# SCHEDULED MODE (optional, `vm_schedule_enabled = true`): "is the backend up when it should be?"
# A Cloud Scheduler job GETs /health 30 min after the scheduled VM start
# (boot + service start take ~2 min on an e2-micro; 3 retries a minute apart
# absorb a slow morning), and a log-based alert fires when the job itself
# reports failure. This is the 3rd Cloud Scheduler job in the project (the
# other two are the Cloud Functions' cron triggers) — still inside the free
# tier. `backend_fatal_crash` below remains the fast signal for a unit that
# fails to start at all.
resource "google_cloud_scheduler_job" "window_health" {
  count = var.vm_schedule_enabled ? 1 : 0

  project          = var.project_id
  region           = var.region
  name             = "pm-backend-window-health"
  description      = "In-window /health ping — replaces the 24/7 uptime check while the VM runs on a schedule (docs/08 §8.2)."
  schedule         = var.vm_health_ping_cron
  time_zone        = "Asia/Kolkata"
  attempt_deadline = "30s"

  retry_config {
    retry_count          = 3
    min_backoff_duration = "60s"
    max_backoff_duration = "120s"
  }

  http_target {
    http_method = "GET"
    uri         = "https://${var.domain}/health"
  }

  depends_on = [google_project_service.this]
}

resource "google_logging_metric" "window_health_failed" {
  count = var.vm_schedule_enabled ? 1 : 0

  project     = var.project_id
  name        = "pm-window-health-failed"
  description = "The in-window /health ping (Cloud Scheduler job pm-backend-window-health) failed after retries — the backend is not up during trading hours."
  # VERIFY-LIVE (infra): Cloud Scheduler logs a job's final failure with
  # resource.type="cloud_scheduler_job" at severity ERROR; confirm the label
  # name (job_id) and severity on the first real failure and tighten if needed.
  filter = "resource.type=\"cloud_scheduler_job\" AND resource.labels.job_id=\"pm-backend-window-health\" AND severity>=ERROR"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_monitoring_alert_policy" "window_health_failed" {
  count = var.vm_schedule_enabled ? 1 : 0

  project      = var.project_id
  display_name = "pm-backend not up during trading window"
  combiner     = "OR"

  conditions {
    display_name = "in-window /health ping failed"
    condition_threshold {
      filter          = "resource.type=\"cloud_scheduler_job\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.window_health_failed[0].name}\""
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

  documentation {
    content   = "The VM should have been started by its instance schedule 30 min ago and /health is not answering. Check: instance schedule fired (Compute Engine → VM → details), `systemctl status pm-backend caddy` over IAP SSH, Caddy certificate. Fail-closed means no orders until this is green. Incident playbook: infra/README.md#incident-playbook."
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
    display_name = "> 2 (i.e. >= 3) AUTH_EXPIRED in 5m"
    condition_threshold {
      filter          = "resource.type=\"gce_instance\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.this["auth_expired"].name}\""
      comparison      = "COMPARISON_GT" # the Monitoring API allows only LT/GT here — "> 2" is how ">= 3" is expressed
      threshold_value = 2
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
