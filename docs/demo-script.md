# openfloor two-person demo script

A walkthrough for two presenters (a **Host**, who is the session owner, and
a **Guest**, a second session member) to show off real openfloor
functionality: live multiplayer presence, a persistent shared floor, three
differently-scoped agents, three real GitHub-backed Codex runs with live
activity streaming, and the honest review/merge flow — all run live,
nothing pre-staged.

Everything here reflects what is actually implemented today (see
`AGENTS.md` and `docs/agent-backend-gaps.md`). Nothing in this script asks
you to fake, seed, or narrate around a feature that doesn't exist yet.

**This version runs all three agents live and starts from a genuinely
empty repo.** That's more honest and more impressive, but it means three
real sequential/parallel Codex runs happen on stage — see the timing budget
near the bottom before you commit to a slot length. Don't try to squeeze
this into 20 minutes; give it 35–45.

---

## 0. Before the audience shows up (10–15 min prep, not part of the demo)

Do this alone, ahead of time:

1. **Create a disposable demo GitHub repo with exactly one commit.** It
   needs to be functionally empty (no app code, no UI, no tests) but it
   **cannot have zero commits** — openfloor connects a repo by branching
   from a verified base SHA, and a repo with zero commits has no branch to
   branch from. Seed it with just enough to satisfy that:
   - A `README.md` and nothing else. No source files, no UI, no tests.
   - This keeps the repo honestly empty in spirit — no scaffolding, no
     feature code — while satisfying the platform's real constraint that a
     base branch must exist.
2. **Create the session** and set its **objective** (you can also do this
   live in §2 — it's fast either way).
3. **Connect the repository** as the owner: Session → Repository → Connect,
   install the GitHub App, pick the repo and base branch (e.g. `main`).
   Confirm a candidate branch gets created.
4. **Send the Guest a session invite** ahead of time so they can join the
   moment you go live, rather than fumbling through Cloudflare Access login
   on stage.
5. Have two windows/screens visible if possible — Host's browser and
   Guest's browser side by side — so the audience can see presence and
   live sync happening between two real people, not one person in two tabs.

> Fill in the bracketed `[...]` placeholders below (repo name, presenter
> names) before you present.

---

## 1. Cold open — presence and the shared room (2 min)

**Host** has the session open. **Guest** joins live, on camera, using the
invite link.

Narrate while it happens:
- "This is a session — a persistent room, not a chat window that resets."
- Point at the roster/presence indicator updating in real time as Guest
  connects — this is a real authenticated WebSocket, not a mock.

**Host says out loud / does:** open the session lobby, click **Enter agent
floor**.

**Guest says out loud / does:** click the invite link, sign in, click
**Join**, then **Enter agent floor**.

---

## 2. Set the objective (1 min)

**Host types into the objective field on the floor:**

```
Ship a word-counter feature: a panel where a user pastes/types text and
sees a live word + character count, backed by a real API endpoint, with
test coverage for both the endpoint and the UI behavior.
```

Narrate: "The objective is the shared mission for the room — every agent's
prompt later on will include this automatically."

*(If you set this during prep in §0, just point at it here instead of
retyping it.)*

---

## 3. Create three agents with different scopes (3–4 min)

This is the "agents are customizable" beat. Create these one at a time on
camera (**New Agent** → name / role / task). Task text is intentionally
scoped so the audience sees three agents that *don't* step on each other —
that's the point of the demo, not an accident.

### Agent 1 — UI Agent

- **Name:** `UI Agent`
- **Role:** `Frontend / UI engineer`
- **Task** (paste as-is):

```
You own all frontend/UI work on this floor. This repo is brand new, so
there's no existing design system yet — establish clean, minimal
conventions as you go and stay consistent with your own prior work. Wire
the UI to whatever backend endpoint the Backend Agent builds for the
current objective — check team chat and already-integrated files for its
exact contract before wiring it up; if the endpoint isn't integrated yet,
say so in team chat rather than guessing at its shape. Do not modify
backend route handlers or test files; if you think one of those needs to
change, say so in team chat instead of editing it yourself. Keep diffs
minimal and focused on the current objective.
```

### Agent 2 — Backend Agent

- **Name:** `Backend Agent`
- **Role:** `Backend / API engineer`
- **Task** (paste as-is):

```
You own backend and data work on this floor. This repo is brand new — set
up whatever minimal project structure (package.json, entry point, etc.) is
needed to implement the current objective's API cleanly, keeping it as
small as the objective requires. Once another agent may depend on your
endpoint's request/response shape, keep that contract stable — if you must
change it, say so in team chat first. Do not modify UI components or test
files directly. Make sure `npm test` still passes when you're done, even
if that just means it runs cleanly with no tests yet.
```

### Agent 3 — Test Agent

- **Name:** `Test Agent`
- **Role:** `QA / test engineer`
- **Task** (paste as-is):

```
You own test coverage on this floor. Write tests for code that other
agents add or change in the current objective, using Node's built-in
`node --test` runner (already wired to `npm test`) unless the objective
clearly calls for something else. Only test files that are already
integrated or currently in another agent's finished work — don't invent
tests for code that doesn't exist yet. Cover the normal case,
empty/invalid input, and one boundary case. Do not modify application, UI,
or backend source files — tests and fixtures only. If writing a test
surfaces a bug in someone else's code, report it in team chat rather than
fixing it yourself.
```

Narrate while creating these: "Same product, same floor, three completely
different operating instructions — this is just free text we control per
agent, not three hardcoded modes."

---

## 4. Queue the Backend Agent's work (2 min)

Prompts get typed into the composer and assigned to a target agent. Since
the repo is empty, **Backend Agent has to go first** — UI Agent and Test
Agent both need a real integrated endpoint to build against, not a
guessed-at contract.

**Guest queues, assigned to Backend Agent:**

```
Add a POST /api/word-count endpoint that accepts { text: string } and
returns { words: number, characters: number }. Reject empty text and text
over 10,000 characters with a 400 and a clear error message.
```

Narrate: "This queue is real and persisted — if I reload right now, it's
still here." (Optional: actually reload to prove it, if time allows.)

---

## 5. Run 1 — Backend Agent, live (5–10 min)

**Host** (owner-only action) starts the run for the **Backend Agent**'s
queued item.

While it runs, narrate what's real and point at it live:
- The **activity timeline** streaming actual Codex events (reasoning,
  commands, file edits) — this is a real bounded event feed from the
  sandbox, not a canned animation.
- Expand the **raw log** and the **prompt** expander on the agent card —
  "this second expander shows the *exact* prompt the agent received,
  including the objective, the other agents on this floor and their
  scopes, and recent team chat. Nothing here is fabricated for the demo —
  it's the literal input."
- If a tool call to `openfloor_session_context` shows up in the timeline:
  "that's the agent re-reading live floor state mid-run — it's not
  working from a stale snapshot."

While it runs, **Guest** can queue up the next two prompts (§6) to keep
things moving instead of standing idle.

Once it finishes and integrates, jump into **Review** briefly (full
treatment is in §7) — point at the real diff, the real passing `npm test`
check, and the real draft PR. This is the moment to say: "Notice `npm
test` is green even though there were zero tests a minute ago — Backend
Agent had to make its own change pass the same real check gate every run
goes through."

---

## 6. Queue UI Agent and Test Agent (2 min)

Now that a real endpoint is integrated, queue the other two — split across
presenters so the audience sees both of you directing agents, not just the
Host.

**Host queues, assigned to UI Agent:**

```
Add a word-counter panel to the floor UI with a multiline text input and a
live word + character count that updates as the user types. Call the new
POST /api/word-count endpoint instead of counting client-side, and show a
loading/error state if the request fails.
```

**Guest queues, assigned to Test Agent:**

```
Add tests for the POST /api/word-count endpoint (normal text, empty text,
over-length text). If the word-counter UI component is already integrated
by the time you run, add a test for it too, confirming the count updates
as the user types and an error state renders if the request fails —
otherwise just cover the endpoint.
```

---

## 7. Run 2 — UI Agent and Test Agent, live and in parallel (5–10 min)

**Host** starts both queued runs. They don't conflict — UI Agent only
touches frontend files, Test Agent only touches test files — so this is a
good moment to show two runs streaming side by side on the floor at once.

While they run, **Guest** can send a real team chat message to show chat
is live:

```
Backend's word-count endpoint is already integrated — UI Agent, make sure
you're hitting POST /api/word-count and not re-implementing the count
client-side.
```

Narrate the same real-timeline / real-prompt / live-context-reread points
as in §5 for whichever run the audience is watching. If Test Agent's run
starts before UI Agent's has integrated, point out its prompt only sees
what's real at dispatch time — a good moment to show `openfloor_session_context`
being called mid-run if it re-checks and picks up the UI component once it
lands.

---

## 8. Review and merge (4–5 min)

Once both runs have integrated into the same candidate, open **Review**.

Narrate:
- Point at real GitHub-backed data: changed files across all three agents'
  runs, diff previews, required checks (passed/failed/waiting pulled
  straight from GitHub), the draft PR, mergeability.
- "Three independent agents, one PR — that's the serialized integration
  model. Each run only ever merges non-force into the latest candidate."
- If everything's green: **Host** clicks **Ready for review**, then
  **Squash merge** — call out that this is a real protected-branch squash
  merge against GitHub, not a simulated button.

---

## 9. Close the loop (1–2 min)

- **Reload the floor page** on screen. Agents, queue, messages, run status,
  and review all come back exactly as they were — "everything you just saw
  is durable, not page state."
- One honest sentence on scope: "Agent model choice, agent-authored chat
  replies, and a few other things are deliberately deferred — we'd rather
  ship an honest empty state than fake it. Everything else you saw today is
  real."

---

## Timing budget (target ~35–45 min)

Real Codex runs are the bulk of this. Don't schedule this demo back-to-back
with something else — give the runs room to breathe.

| Section | Time |
| --- | --- |
| 1. Cold open / presence | 2 min |
| 2. Objective | 1 min |
| 3. Create 3 agents | 3–4 min |
| 4. Queue Backend Agent | 2 min |
| 5. Run 1 — Backend, live | 5–10 min |
| 6. Queue UI + Test Agents | 2 min |
| 7. Run 2 — UI + Test, live, parallel | 5–10 min |
| 8. Review/merge | 4–5 min |
| 9. Close | 1–2 min |

---

## Fallback if Codex is slow or a check fails live

Don't debug on stage. Since nothing is pre-staged, plan for this
explicitly rather than hoping for the best:

- **A run is just slow:** this is fine — keep narrating other real floor
  features while it streams (team chat, presence, the queue, the prompt
  expander) rather than standing in silence. Codex runs commonly take
  several minutes; say so up front so the audience isn't wondering if
  something's broken.
- **Running short on time before Run 2 finishes:** it's fine to end the
  live portion at Backend Agent's integrated PR (end of §5) and describe
  the rest ("UI Agent and Test Agent would build on this the same way")
  rather than rushing Review.
