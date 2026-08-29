# Website demo video

The website demo is a matched pair of silent, voiceover-ready MP4s:

- **Light** — the product's cool near-white manual theme.
- **Dark** — the product's near-black manual theme.

Both cuts enter directly on a working Agent Floor. They never show sign-in,
onboarding, the home screen, the session lobby, or repository setup. The visible
story is a code-heavy incident-response build: a backend engineer and frontend
engineer coordinate through populated team goals, live drafts, Team queue,
automatic dispatch, every real run status, Team chat, detailed agent activity,
and Review containing ten distinct application files with code diffs.

## Record both cuts

Docker is not required. The command builds the app, starts the existing isolated
end-to-end Worker and D1 database, stages disposable session state, records both
themes at 1440×900, and exits without touching production or GitHub:

```bash
npm run demo:record
```

During iteration, set `OPENFLOOR_DEMO_THEME=light` or
`OPENFLOOR_DEMO_THEME=dark` to render only one cut.

The outputs are:

```text
artifacts/demo/openfloor-website-demo-light.mp4
artifacts/demo/openfloor-website-demo-dark.mp4
```

The two contexts record the same disposable session concurrently, so content,
timing, identifiers, and actions align; only the theme differs. The MP4s are
silent H.264 video at 30 fps, `yuv420p`, with fast-start encoding for web
delivery. Raw Playwright WebM captures remain under `artifacts/demo/raw-*` for
a future editor. `ffmpeg` and `ffprobe` must be on `PATH`.

## Shot sequence

1. Open on the complete working floor with Forge, Eli's Backend engineer, two
   filled team goals, and an empty Team queue. Click the session objective and
   hold on its editor to establish the goal shared by engineers and agents and
   passed into agent context by the synchronization engine.
2. Create Atlas on camera as Maya's Frontend engineer by typing its name, role,
   and task, then return to All agents.
3. Enable queue auto-dispatch using the real Queue settings control. The queue
   remains in Team scope for the entire capture.
4. Make the single camera move while Eli types the backend implementation
   prompt for Forge, then zoom out as soon as he finishes. While Forge moves
   through provisioning, running, checking, ready, publishing, published,
   integrating, and integrated, Maya visibly types the frontend prompt for
   Atlas. Agent tiles keep the same height as their statuses and activity change.
5. Maya submits the completed frontend dashboard prompt for Atlas. While its
   queue card completes the same lifecycle, open Team chat: Maya types a
   coordination note and Eli replies through his own session after a beat.
6. Click Atlas to show its frontend task, five edited files, two checks, branch,
   activity timeline, raw log, and exact session brief.
7. Open Review and click through all ten backend/frontend files. Every selection
   renders different code before the candidate is marked ready; Team chat stays visible.

## Timestamped voiceover

Use the same narration for either theme. Timestamps are visual cues, not
separate title cards; read the lines continuously at a calm website-demo pace.

| Time | What is on screen | Narration |
| --- | --- | --- |
| 00:00.15 | Session objective opens, followed by the beginning of agent creation. | "The session objective is the main goal shared by engineers and agents. Open Floor's synchronization engine passes it into every agent's context." |
| 00:07.75 | Maya finishes creating Atlas and auto-dispatch is enabled. | "Create specialized frontend and backend agents, each with its own role and operating task." |
| 00:12.75 | Camera zooms out when Eli finishes. His backend prompt enters Team queue while Maya concurrently types the frontend work. | "Eli sends the backend build to Forge while Maya prepares the frontend in parallel, with every execution step visible." |
| 00:19.05 | Maya's prepared dashboard prompt runs while Team chat shows Maya and Eli coordinating. | "Maya's prepared frontend work auto-dispatches through the same auditable pipeline. Team chat keeps their decisions in the session while Atlas runs." |
| 00:27.00 | Atlas focus shows five changed files, two checks, activity, branch, and raw log. | "Open any agent to inspect its code activity, checks, branch, and execution log." |
| 00:32.30 | Exact session brief opens. | "The exact shared context sent to the agent stays attached to the run." |
| 00:36.00 | Review clicks through ten distinct API, persistence, event, UI, style, and test files with real code diffs. | "Finally, review the complete application file by file, with every diff and required check ready for approval, so the whole team can ship with confidence." |

Do not claim the local recording's test adapter is a live model invocation; the
video demonstrates the real product workflow and UI with disposable staged
data.

## Capture boundary

The recorder intentionally reuses test-only identity, GitHub, and agent-run
adapters. Those adapters never enter production code or production data. Demo
run pacing only delays this test seam and broadcasts genuine persisted status
changes; production execution timing is untouched. The
theme is set before first paint through the same `openfloor:theme` preference
used by the product: the exact stored values are `light` and `dark`.
