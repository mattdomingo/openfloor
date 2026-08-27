# Bug report: two small deserializer strictness issues block major coding agents from api.x.ai

**Product:** xAI API (`api.x.ai`)
**Endpoints:** `POST /v1/messages` (Anthropic-compatible), `POST /v1/responses`
**Models tested:** `grok-4.5`, `grok-4.6`
**Dates observed:** 2026-08-24, re-verified 2026-08-26
**Impact:** Claude Code cannot run against `/v1/messages`; OpenAI Codex CLI cannot complete any multi-turn thread against `/v1/responses`. Each issue is a single-field strictness difference from the reference implementations; fixing either one immediately unblocks a widely used coding agent on Grok.

---

## Issue 1 — `/v1/messages` rejects `role: "system"` entries inside `messages[]`

### Behavior

The Claude Code CLI routinely places system-reminder entries with `role: "system"` inside the `messages[]` array (in addition to the top-level `system` field). `api.anthropic.com` accepts these, and so do other Anthropic-compatible providers we tested (Moonshot `api.moonshot.ai/anthropic`, Z.ai `api.z.ai/api/anthropic` — Z.ai's schema explicitly enumerates `system` as a legal message role). `api.x.ai` rejects the request:

```
HTTP 400
{"code":"invalid-argument","error":"Invalid request content: Invalid message role."}
```

Because the CLI's very first real request in any session carries such an entry, this makes `/v1/messages` unusable for Claude Code end to end, even though simple requests work perfectly (both `authorization: Bearer` and `x-api-key` accepted; SSE framing matches Anthropic exactly).

### Minimal repro

```bash
curl -sS -w '\nHTTP %{http_code}\n' -X POST https://api.x.ai/v1/messages \
  -H "authorization: Bearer $XAI_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "grok-4.5",
    "max_tokens": 256,
    "system": "You are a coding assistant.",
    "tools": [{"name": "write_file", "description": "Write a file to disk",
      "input_schema": {"type": "object",
        "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
        "required": ["path", "content"]}}],
    "messages": [
      {"role": "user", "content": "Create hello.txt containing the word hi. Use the write_file tool."},
      {"role": "system", "content": "<system-reminder>This is a system reminder entry.</system-reminder>"}
    ]
  }'
```

Observed: `400 {"code":"invalid-argument","error":"Invalid request content: Invalid message role."}`

### Isolation

Replaying a captured real Claude Code request with the single `role: "system"` entry rewritten to `"user"` — and no other change — returns `200` with a correct `tool_use` block. The role is the sole blocker.

### Requested fix

Accept `role: "system"` entries inside `messages[]` (treating them as system/user-context content, as the reference implementation does), or document the deviation. This one change makes Grok a drop-in provider for Claude Code and every Anthropic-SDK-based agent.

---

## Issue 2 — `/v1/responses` rejects replayed reasoning input items that carry an explicit `"content": null`

### Behavior

The OpenAI Codex CLI (verified at `@openai/codex-sdk` 0.148.0 and 0.149.1, the latest published release) runs fully stateless against Responses providers: `store: false`, `include: ["reasoning.encrypted_content"]`, no `previous_response_id` — it replays the full item history on every request. When it replays the prior turn's reasoning item, its serializer includes an explicit `"content": null` field on that item. `api.x.ai` rejects the request:

```
HTTP 400
{"code":"invalid-argument","error":"Could not decode the compaction blob. Ensure it is unmodified from the compact response."}
```

Turn one works (after disabling the CLI's collab tooling, whose `tools[].type: "namespace"` your deserializer 422s — reasonable). But the **second** model request of every thread fails as above, so no multi-turn Codex session can complete against Grok.

### Isolation (byte-level, performed 2026-08-24 and re-verified live 2026-08-26)

Using a logging proxy between the unmodified Codex CLI and `https://api.x.ai/v1`:

- Your own reasoning item, replayed byte-exact: `200`.
- The same item in Codex's serialization (adds `"content": null`): `400` as above.
- The failing request body with **only** the `content` field deleted from the reasoning item, all else byte-identical (including `encrypted_content`): `200`.
- Control probes: dropping `status` alone, or mutating summary text, still `200`.

So the encrypted blob is fine and unmodified; the deserializer treats the presence of a null `content` key on the reasoning input item as blob corruption. The error message ("compaction blob… unmodified") is also misleading for this case — the blob *is* unmodified.

Additional data point: `reasoning: {"effort": "none"}` is rejected by both `grok-4.5` and `grok-4.6` (`400 {"code":"invalid-argument","error":"This model does not support 'reasoning_effort' value 'none'."}`), which closes the workaround of suppressing reasoning items entirely.

### Requested fix

Tolerate an explicit `content: null` on replayed reasoning input items (treat it as the field being absent). This one change unblocks the Codex CLI — and likely any other stateless Responses client that round-trips items through a serializer that materializes optional fields as `null`.

---

## Environment notes

- Auth: scratch pay-as-you-go key from console.x.ai.
- `/v1/messages/count_tokens` returns 404 (fine, noted for completeness).
- Both issues reproduce identically over plain HTTPS POST; the Responses tests also exercised the CLI's WebSocket-first behavior (five `ws://…/responses` upgrade attempts before HTTP fallback), which is unrelated to either failure.
- Happy to provide the full proxy captures (request/response bodies with the key redacted) on request.
