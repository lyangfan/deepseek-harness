# @deepseek-ai/dsh-evidence-service

Read-only Evidence query remote service (SPEC-05) over the private evidence-core owner store: the browser-readable channel for current/historical Snapshots, candidate lists, local paths, object details, Receipt status, issues with markSeen, precise navigation, PreviewFragment, and canonical export.

English | [中文](README.zh.md)

## Model Experience

None, as this package registers no model-visible surface; every model dispatch is owned by the evidence-core semantic lane (or the browser shell for the view plugin).

#### KV Cache effect

Zero — no model prompts are generated, so no cache entries are created.

## Known Limitations and Deferred Work

- **Browser-only consumer**: the service namespace `evidence` is mounted only through the browser api-remotes assembly; headless hosts see the store via `ctx.evidenceStore` directly.
- **Preview anchors limited to text/csv_table**: the SPEC-02 registered anchor kinds; document/web anchors return an honest `metadata` fragment until their verifiers exist.
- **No subscription for per-query invalidation**: the `evidence/updated` event carries three version tokens (materialStateDigest, headRevision, issuesRevision); clients dedup and re-query but there is no server-push of query results.
