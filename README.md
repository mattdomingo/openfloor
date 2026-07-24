# OpenFloor

OpenFloor is a multiplayer development environment for teams coordinating multiple coding agents against one shared software objective.

This repository currently contains the first mocked vertical slice: a mission-control-style shared session with participants, task dispatch, parallel agent cards, status changes, changed-file attribution, conflict resolution, and combined repository checks.

## Local development

```bash
npm install
npm run dev
```

Open the local URL printed by the development server.

## Project direction

See [`docs/project-context.md`](docs/project-context.md) for the product model, MVP architecture, event protocol, conflict policy, implementation sequence, assumptions, and open decisions.
