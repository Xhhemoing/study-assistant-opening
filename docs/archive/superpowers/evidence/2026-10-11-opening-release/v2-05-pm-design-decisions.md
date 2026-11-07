# V2-05 PM design decisions

**Date:** 2026-10-11（Asia/Shanghai）  
**Baseline tip:** `5d71248`  
**Sources:** `v2-05-teaching-content-understand.md`, `v2-05-teaching-content-plan.md`, ADR D2

## Approved defaults

1. **Same library document + server-side redact** — Teaching body sole store is library Document/Block/Revision; answer_key plaintext never in client init / restore; opaque `answerRef` until authorized reveal.
2. **TeachingUnit 1:N activities** — One reusable unit (→ one library doc) may bind many activities via ActivitySpec; each activity has at most one current spec (`UNIQUE activity_id`).
3. **Drafts via checkpoint (+ optional scratch doc)** — Mid-lesson drafts in `checkpoint_json` (and optional personal scratch library doc); not in TeachingUnit body; lost blockIds → explicit `draft_anchor_lost`, no silent remap.

## Also locked

- No second body store; no chat-as-lesson; no parallel teaching answer ledger.
- Migration placeholder `00xx` until Integrator assigns (tip ends 0053).
- Plan ACCEPT → then Implement; no ALTER until then.
- No push / hermes unless Paula asks.

**PM:** Projects Manager — approve Plan for Integrator Accept gate.
