# ACDP Control-Plane reference policy.
#
# Mirrors the static-rules backend's decision tree (src/policy/
# static-rules-policy.decider.ts). Behaviour differs for an authenticated
# context.retrieve with resource_visibility null — which PolicyGuard always
# sends today: static allows it, this corpus matches no rule
# (indeterminate → 403). Add a rule for that case before switching
# POLICY_BACKEND=static → POLICY_BACKEND=opa. See docs/POLICY.md.
# Customize per-tenant by overriding individual rules in a
# `bundles/<tenant-id>/policy.rego` file shipped alongside this one.
#
# Run the test suite with:
#   opa test docs/policies/
#
# To serve this corpus with the OPA sidecar:
#   docker run -p 8181:8181 -v $PWD/docs/policies:/policies \
#     openpolicyagent/opa:latest run --server --addr :8181 /policies
#
# Then set OPA_URL=http://opa:8181 OPA_PACKAGE_PATH=acdp/policy/v1
# POLICY_BACKEND=opa.

package acdp.policy.v1

# ── Input contract (set by src/policy/opa-policy.decider.ts) ────────
#
#   input.subject_did          string         (empty = unauthenticated)
#   input.action               string         (one of the PolicyAction enum)
#   input.resource_id          string
#   input.resource_visibility  string | null  ("public"|"restricted"|"private")
#   input.resource_audience    array[string]
#   input.scopes               array[string]
#   input.tenant_id            string
#   input.issuer               string   verified JWT iss ('' for api-key callers)
#   input.federated            boolean  true = token from a TRUSTED_ISSUERS entry
#
# ── Output contract (consumed by interpretOpa()) ───────────────────
#
#   { "allow": true }
#   { "allow": false, "deny_code": "<code>", "deny_reason": "<text>" }
#   { "indeterminate": true, "note": "<text>" }

# Default to indeterminate so missing rules surface as a coverage gap
# (PolicyGuard treats indeterminate as deny + logs a warn).
default decision := {"indeterminate": true, "note": "no rule matched"}

# ── Unauthenticated allow-list ──────────────────────────────────────

decision := {"allow": true} if {
  input.subject_did == ""
  input.action == "context.retrieve"
  input.resource_visibility == "public"
}

decision := {"allow": true} if {
  input.subject_did == ""
  input.action == "context.list"
}

decision := {
  "allow": false,
  "deny_code": "unauthenticated",
  "deny_reason": sprintf("action '%s' requires a subject", [input.action]),
} if {
  input.subject_did == ""
  input.action != "context.retrieve"
  input.action != "context.list"
}

# ── Visibility / audience (retrieve only) ───────────────────────────

decision := {"allow": true} if {
  input.subject_did != ""
  input.action == "context.retrieve"
  input.resource_visibility == "public"
}

decision := {
  "allow": false,
  "deny_code": "visibility",
  "deny_reason": "resource is private",
} if {
  input.subject_did != ""
  input.action == "context.retrieve"
  input.resource_visibility == "private"
}

decision := {"allow": true} if {
  input.subject_did != ""
  input.action == "context.retrieve"
  input.resource_visibility == "restricted"
  count(input.resource_audience) > 0
  input.subject_did in input.resource_audience
}

decision := {
  "allow": false,
  "deny_code": "audience",
  "deny_reason": "subject not in restricted audience",
} if {
  input.subject_did != ""
  input.action == "context.retrieve"
  input.resource_visibility == "restricted"
  not (input.subject_did in input.resource_audience)
}

# ── Default-allow for non-retrieve actions once subject is present ──
#
# Mirrors the static-rules tree: after auth + tenant + scope gates,
# publish/list/etc. default allow. Tenants who want stricter rules
# override these in their bundle.

decision := {"allow": true} if {
  input.subject_did != ""
  input.action in {
    "context.publish",
    "context.list",
    "capability.declare",
    "run.start",
    "run.read",
  }
}
