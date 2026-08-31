# @deepseek-ai/dsh-client-ui-evidence

Evidence read view (SPEC-05): the candidate-first `conversation.view` tab, Session-header status entry, and tool-card navigation links. All data flows through `ctx.remote.evidence`; the view never touches the owner store.

English | [中文](README.zh.md)

## Model Experience

None, as this package registers no model-visible surface; every model dispatch is owned by the evidence-core semantic lane (or the browser shell for the view plugin).

#### KV Cache effect

Zero — no model prompts are generated, so no cache entries are created.

## Known Limitations and Deferred Work

- **No virtualization or infinite scroll**: fixed cursor pages of 50 with exact totals (spec §9.3, D-141 exclusion).
- **Chat inline nodes unused**: the view registers no `conversation.chat.node` entries (SPEC-05 §1.3 terminology correction).
- **Accessibility deferred**: no evidence-specific WCAG gate; text semantics preserved for all scientific states (D-143).
