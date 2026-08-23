import { chromium } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const port = process.env.OPENFLOOR_DEMO_PORT ?? "8797";
const origin = `http://127.0.0.1:${port}`;
const outputDir = resolve(process.env.OPENFLOOR_DEMO_OUTPUT ?? "artifacts/demo");
const viewport = { width: 1440, height: 900 };
const themes = [
  { name: "Polar", value: "polar", colorScheme: "light", slug: "polar" },
  { name: "Midnight", value: "midnight", colorScheme: "dark", slug: "midnight" },
];
const requestedTheme = process.env.OPENFLOOR_DEMO_THEME?.toLowerCase();
const selectedThemes = requestedTheme ? themes.filter((theme) => theme.slug === requestedTheme) : themes;
const sessionObjective = "Build a realtime incident-response dashboard with live service health, alert triage, and tested APIs.";
const eliPrompt = "Implement incident APIs, realtime events, persistence, and backend tests.";
const mayaPrompt = "Build the realtime incident dashboard with service health, alert triage, and frontend tests.";
const backendFiles = [
  demoFile("app/api/incidents/route.ts", "Incident collection API", [
    'import { NextResponse } from "next/server";',
    'import { createIncident, listIncidents } from "@/server/incidents/store";',
    "",
    "export async function GET() {",
    "  return NextResponse.json({ incidents: await listIncidents() });",
    "}",
    "",
    "export async function POST(request: Request) {",
    "  const input = await request.json();",
    "  const incident = await createIncident(input);",
    "  return NextResponse.json({ incident }, { status: 201 });",
    "}",
  ]),
  demoFile("lib/incidents/types.ts", "Shared incident contracts", [
    'export type IncidentSeverity = "critical" | "warning" | "resolved";',
    "",
    "export type Incident = {",
    "  id: string;",
    "  service: string;",
    "  summary: string;",
    "  severity: IncidentSeverity;",
    "  acknowledgedAt: number | null;",
    "  createdAt: number;",
    "};",
  ]),
  demoFile("server/incidents/events.ts", "Realtime incident event stream", [
    'import type { Incident } from "@/lib/incidents/types";',
    "",
    "const listeners = new Set<(incident: Incident) => void>();",
    "",
    "export function publishIncident(incident: Incident) {",
    "  for (const listener of listeners) listener(incident);",
    "}",
    "",
    "export function subscribeToIncidents(listener: (incident: Incident) => void) {",
    "  listeners.add(listener);",
    "  return () => listeners.delete(listener);",
    "}",
  ]),
  demoFile("server/incidents/store.ts", "Validated incident persistence", [
    'import type { Incident } from "@/lib/incidents/types";',
    'import { publishIncident } from "./events";',
    "",
    "const incidents = new Map<string, Incident>();",
    "",
    "export async function listIncidents() {",
    "  return [...incidents.values()].sort((a, b) => b.createdAt - a.createdAt);",
    "}",
    "",
    "export async function createIncident(input: Pick<Incident, \"service\" | \"summary\" | \"severity\">) {",
    "  const incident: Incident = { ...input, id: crypto.randomUUID(), acknowledgedAt: null, createdAt: Date.now() };",
    "  incidents.set(incident.id, incident);",
    "  publishIncident(incident);",
    "  return incident;",
    "}",
  ]),
  demoFile("tests/server/incidents.test.ts", "Backend API and event coverage", [
    'import { describe, expect, it, vi } from "vitest";',
    'import { createIncident, listIncidents } from "@/server/incidents/store";',
    'import { subscribeToIncidents } from "@/server/incidents/events";',
    "",
    'describe("incident store", () => {',
    '  it("persists and broadcasts new incidents", async () => {',
    "    const listener = vi.fn();",
    "    const unsubscribe = subscribeToIncidents(listener);",
    '    const incident = await createIncident({ service: "API", summary: "Latency spike", severity: "critical" });',
    "    expect(await listIncidents()).toContainEqual(incident);",
    "    expect(listener).toHaveBeenCalledWith(incident);",
    "    unsubscribe();",
    "  });",
    "});",
  ]),
];
const frontendFiles = [
  demoFile("app/incidents/incidents.css", "Responsive operations dashboard styling", [
    ".incident-dashboard { display: grid; gap: 1.5rem; padding: 2rem; }",
    ".health-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: 1rem; }",
    ".health-card { border: 1px solid var(--line-soft); border-radius: 12px; padding: 1rem; }",
    '.health-card[data-state="critical"] { border-color: var(--status-blocked); }',
    ".incident-list { display: grid; gap: 0.75rem; margin: 0; padding: 0; list-style: none; }",
  ]),
  demoFile("app/incidents/page.tsx", "Server-loaded incident dashboard route", [
    'import { IncidentDashboard } from "@/components/incidents/IncidentDashboard";',
    'import { listIncidents } from "@/server/incidents/store";',
    'import "./incidents.css";',
    "",
    "export default async function IncidentsPage() {",
    "  const incidents = await listIncidents();",
    "  return <IncidentDashboard initialIncidents={incidents} />;",
    "}",
  ]),
  demoFile("components/incidents/IncidentDashboard.test.tsx", "Dashboard interaction coverage", [
    'import { render, screen } from "@testing-library/react";',
    'import userEvent from "@testing-library/user-event";',
    'import { IncidentDashboard } from "./IncidentDashboard";',
    "",
    'it("filters critical incidents and acknowledges work", async () => {',
    "  render(<IncidentDashboard initialIncidents={fixtures} />);",
    '  await userEvent.click(screen.getByRole("button", { name: "Critical" }));',
    '  expect(screen.getByText("API latency spike")).toBeVisible();',
    '  expect(screen.queryByText("Search recovered")).not.toBeInTheDocument();',
    "});",
  ]),
  demoFile("components/incidents/IncidentDashboard.tsx", "Interactive incident triage workspace", [
    '"use client";',
    'import { useMemo, useState } from "react";',
    'import type { Incident } from "@/lib/incidents/types";',
    'import { ServiceHealthGrid } from "./ServiceHealthGrid";',
    "",
    "export function IncidentDashboard({ initialIncidents }: { initialIncidents: Incident[] }) {",
    '  const [filter, setFilter] = useState<"all" | "critical">("all");',
    '  const visible = useMemo(() => filter === "all" ? initialIncidents : initialIncidents.filter((item) => item.severity === "critical"), [filter, initialIncidents]);',
    "  return <main className=\"incident-dashboard\">",
    "    <header><h1>Incident command</h1><button onClick={() => setFilter(\"critical\")}>Critical</button></header>",
    "    <ServiceHealthGrid incidents={visible} />",
    "    <ul className=\"incident-list\">{visible.map((item) => <li key={item.id}>{item.summary}</li>)}</ul>",
    "  </main>;",
    "}",
  ]),
  demoFile("components/incidents/ServiceHealthGrid.tsx", "Live service health summary", [
    'import type { Incident } from "@/lib/incidents/types";',
    "",
    "export function ServiceHealthGrid({ incidents }: { incidents: Incident[] }) {",
    "  const services = Map.groupBy(incidents, (incident) => incident.service);",
    "  return <section className=\"health-grid\" aria-label=\"Service health\">",
    "    {[...services].map(([service, active]) => <article className=\"health-card\" data-state={active[0].severity} key={service}>",
    "      <strong>{service}</strong>",
    "      <span>{active.length} active incident{active.length === 1 ? \"\" : \"s\"}</span>",
    "    </article>)}",
    "  </section>;",
    "}",
  ]),
];
const reviewFilePaths = [...backendFiles, ...frontendFiles].map((file) => file.path);
if (selectedThemes.length === 0) throw new Error("OPENFLOOR_DEMO_THEME must be polar or midnight");

mkdirSync(outputDir, { recursive: true });

const server = spawn(process.execPath, ["tests/e2e/server.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    OPENFLOOR_E2E_PORT: port,
    OPENFLOOR_TEST_AGENT_RUN_DATA: JSON.stringify({
      stageDelayMs: 800,
      filesByPrompt: { [eliPrompt]: backendFiles, [mayaPrompt]: frontendFiles },
      log: "$ npm test\n✓ incident API tests\n✓ incident dashboard tests\n\n$ npm run typecheck\n✓ no type errors\n\nIncident dashboard implementation ready for review.\n",
    }),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverLog = "";
for (const stream of [server.stdout, server.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    serverLog = `${serverLog}${chunk}`.slice(-12_000);
  });
}

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });
  const setup = await prepareSession();
  await recordMatchedThemes(setup);
} catch (error) {
  if (serverLog) process.stderr.write(`\nLocal demo server output:\n${serverLog}\n`);
  throw error;
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}

async function recordMatchedThemes(setup) {
  process.stdout.write(`Recording ${selectedThemes.map((theme) => theme.name).join(" and ")} from one aligned session…\n`);
  const captures = await Promise.all(selectedThemes.map((theme) => createCapture(theme, setup)));
  const pages = captures.map((capture) => capture.page);
  const controller = captures[0].page;

  await Promise.all(pages.map(async (page) => {
    await page.goto(setup.floorUrl, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Agent floor" }).waitFor();
    await page.getByText("No prompts waiting", { exact: true }).waitFor();
    await expectPressed(page.getByRole("group", { name: "Queue scope" }).getByRole("button", { name: "Team", exact: true }));
    await assertTopBarLayout(page);
  }));

  await pauseAll(pages, 500);

  // Open the shared objective before any work starts. This is the exact goal
  // included in each agent's synchronized session brief, not demo-only copy.
  await Promise.all(pages.map((page) => page.getByRole("button", { name: sessionObjective }).click()));
  await Promise.all(pages.map((page) => page.getByLabel("Session objective").waitFor()));
  await pauseAll(pages, 1_350);
  await Promise.all(pages.map((page) => page.getByLabel("Session objective").press("Escape")));
  await Promise.all(pages.map((page) => page.getByLabel("Session objective").waitFor({ state: "hidden" })));
  await pauseAll(pages, 250);

  // Create the featured specialist on camera. Only the controller submits
  // the durable mutation; the matched theme context mirrors the typing and
  // closes after the realtime agent update arrives.
  await Promise.all(pages.map((page) => page.getByRole("region", { name: "Agent floor" }).getByRole("button", { name: "New agent" }).click()));
  const dialogs = pages.map((page) => page.getByRole("dialog"));
  await Promise.all(dialogs.map((dialog) => dialog.getByLabel("Name", { exact: true }).pressSequentially("Atlas", { delay: 90 })));
  await Promise.all(dialogs.map((dialog) => dialog.getByLabel("Role", { exact: true }).pressSequentially("Frontend engineer", { delay: 45 })));
  await Promise.all(dialogs.map((dialog) => dialog.getByLabel("Task", { exact: true }).pressSequentially("Build the incident dashboard UI, realtime client state, accessibility, and frontend tests.", { delay: 22 })));
  await pauseAll(pages, 350);
  await dialogs[0].getByRole("button", { name: "Create agent" }).click();
  await Promise.all(pages.map((page) => page.getByRole("tab", { name: "Atlas" }).waitFor()));
  await Promise.all(dialogs.slice(1).map((dialog) => dialog.getByRole("button", { name: "Cancel" }).click()));
  await Promise.all(pages.map((page) => page.getByRole("button", { name: "All agents" }).click()));
  await Promise.all(pages.map((page) => assertAgentCardLayout(page)));
  const agentCardHeights = await Promise.all(pages.map((page) => readAgentCardHeights(page)));
  await pauseAll(pages, 1_400);

  // Turn on the product's real queue auto-dispatch while the shared queue is
  // still empty. Both prompts added on camera remain visible in Team scope.
  await Promise.all(pages.map((page) => page.getByRole("button", { name: "Queue settings" }).click()));
  await Promise.all(pages.map((page) => page.getByRole("group", { name: "Queue settings" }).getByRole("button", { name: /^On/ }).click()));
  await Promise.all(pages.map((page) => page.waitForFunction(() => document.querySelector('[aria-label="Queue settings"]')?.getAttribute("title")?.includes("Auto-dispatch on"))));
  await pauseAll(pages, 650);

  // The only close camera move: isolate the bottom-right live-draft lane while
  // the second engineer types, then return to the full session for every beat.
  await cameraAll(pages, "96% 96%", 1.18);
  await setup.memberPage.getByRole("combobox", { name: "Queue target" }).click();
  await setup.memberPage.getByRole("option", { name: "Forge" }).click();
  const teammateDraft = setup.memberPage.getByLabel("Prompt to add to the queue");
  await teammateDraft.pressSequentially(eliPrompt, { delay: 48 });
  await Promise.all(pages.map((page) => page.getByLabel("Eli R.'s draft").waitFor()));
  await cameraAll(pages, "50% 50%", 1);

  // Maya begins composing the frontend work before Eli submits, then keeps
  // typing while Forge moves through every queue stage. This makes concurrent
  // production visible without fabricating production-side activity.
  await Promise.all(pages.map(async (page) => {
    await page.getByRole("combobox", { name: "Queue target" }).click();
    await page.getByRole("option", { name: "Atlas" }).click();
  }));
  const mayaInputs = pages.map((page) => page.getByLabel("Prompt to add to the queue"));
  const mayaTyping = Promise.all(mayaInputs.map((input) => input.pressSequentially(mayaPrompt, { delay: 72 })));
  await pauseAll(pages, 150);
  await setup.memberPage.getByRole("button", { name: "Add to queue" }).click();
  const eliQueueItems = pages.map((page) => page.locator("li.queue-item", { hasText: eliPrompt }));
  await Promise.all(eliQueueItems.map((item) => item.waitFor()));
  await Promise.all(pages.map((page) => expectPressed(page.getByRole("group", { name: "Queue scope" }).getByRole("button", { name: "Team", exact: true }))));
  await waitForQueueLifecycle(eliQueueItems, async (status) => {
    await assertAgentCardHeights(pages, agentCardHeights, status);
    if (["provisioning", "running", "integrating"].includes(status)) {
      await assertConcurrentTyping(mayaInputs, status);
    }
  });
  await mayaTyping;
  await controller.getByRole("button", { name: "Add to queue" }).click();
  await Promise.all(pages.slice(1).map((page) => page.getByLabel("Prompt to add to the queue").fill("")));

  const mayaQueueItems = pages.map((page) => page.locator("li.queue-item", { hasText: mayaPrompt }));
  await Promise.all(mayaQueueItems.map((item) => item.waitFor()));
  await Promise.all(pages.map((page) => expectPressed(page.getByRole("group", { name: "Queue scope" }).getByRole("button", { name: "Team", exact: true }))));
  const mayaLifecycle = waitForQueueLifecycle(mayaQueueItems, (status) => assertAgentCardHeights(pages, agentCardHeights, status));

  // Keep Maya's lifecycle visible in Queue while Team chat runs alongside it.
  // Her note is typed on camera; Eli answers from his own session after a
  // conversational delay, all before Atlas finishes integrating.
  await Promise.all(pages.map((page) => page.getByRole("region", { name: "Team" }).getByRole("button", { name: "Chat", exact: true }).click()));
  const mayaMessage = "Atlas is wiring the dashboard. Forge, post the API contract when it lands.";
  await Promise.all(pages.map((page) => page.getByLabel("Message the team").pressSequentially(mayaMessage, { delay: 28 })));
  await controller.getByRole("button", { name: "Send message" }).click();
  await Promise.all(pages.slice(1).map((page) => page.getByLabel("Message the team").fill("")));
  await Promise.all(pages.map((page) => page.getByText(mayaMessage, { exact: true }).waitFor()));
  await pauseAll(pages, 1_600);
  await setup.memberPage.goto(setup.floorUrl, { waitUntil: "networkidle" });
  await setup.memberPage.getByRole("heading", { name: "Agent floor" }).waitFor();
  await setup.memberPage.getByRole("region", { name: "Team" }).getByRole("button", { name: "Chat", exact: true }).click();
  const eliMessage = "Backend is integrated—the incident stream and API tests are ready.";
  await setup.memberPage.getByLabel("Message the team").fill(eliMessage);
  await setup.memberPage.getByRole("button", { name: "Send message" }).click();
  await Promise.all(pages.map((page) => page.getByText(eliMessage, { exact: true }).waitFor()));
  await Promise.all([mayaLifecycle, pauseAll(pages, 650)]);
  const agentCards = pages.map((page) => page.locator("article.agent-card", { hasText: "Atlas" }));
  await Promise.all(agentCards.map((card) => card.getByText("integrated", { exact: true }).waitFor()));
  await pauseAll(pages, 450);

  // Enter the agent explicitly so viewers see its task, provider, activity
  // timeline, checks, branch, and inspectable artifacts in one focused view.
  await Promise.all(agentCards.map((card) => card.click()));
  await Promise.all(pages.map((page) => page.getByRole("heading", { name: "Atlas", exact: true }).waitFor()));
  await pauseAll(pages, 700);
  await Promise.all(pages.map((page) => page.getByText("Reviewing the requested change before editing.").waitFor()));
  await pauseAll(pages, 1_100);

  await Promise.all(pages.map((page) => page.getByRole("button", { name: "Open raw log" }).click()));
  await Promise.all(pages.map((page) => page.getByText("Incident dashboard implementation ready for review.").waitFor()));
  await pauseAll(pages, 1_300);
  await Promise.all(pages.map(async (page) => {
    await page.getByRole("button", { name: "Hide raw log" }).click();
    await page.getByRole("button", { name: "Session brief sent to this agent" }).click();
    await page.locator(".agent-raw-log-output").waitFor();
  }));
  await pauseAll(pages, 2_100);
  await Promise.all(pages.map((page) => page.getByRole("button", { name: "Hide session brief" }).click()));
  await pauseAll(pages, 300);

  await Promise.all(pages.map((page) => page.getByRole("button", { name: "Review", exact: true }).click()));
  await Promise.all(pages.map(async (page) => {
    await page.getByRole("heading", { name: /openfloor\// }).waitFor();
    await page.getByText(reviewFilePaths[0].split("/").pop(), { exact: true }).waitFor();
  }));
  await pauseAll(pages, 1_000);
  for (const path of reviewFilePaths.slice(1)) {
    await Promise.all(pages.map(async (page) => {
      await page.locator("button.review-file", { hasText: path }).click();
      await page.getByRole("heading", { name: path, exact: true }).waitFor();
    }));
    await pauseAll(pages, 700);
  }
  await controller.getByRole("button", { name: "Ready for review" }).click();
  await Promise.all(pages.map((page) => page.getByRole("link", { name: /PR #\d+ · open/ }).waitFor()));
  await pauseAll(pages, 1_700);

  await Promise.all(captures.map((capture) => capture.context.close()));
  await setup.memberContext.close();
  const rawPaths = await Promise.all(captures.map((capture) => capture.video.path()));
  const matchedDuration = Math.floor(Math.min(...rawPaths.map(readDuration)) * 30) / 30;
  const outputDurations = [];
  for (const [index, capture] of captures.entries()) {
    const rawPath = rawPaths[index];
    const outputPath = resolve(outputDir, `openfloor-website-demo-${capture.theme.slug}.mp4`);
    transcode(rawPath, outputPath, matchedDuration);
    outputDurations.push(verifyDuration(outputPath));
    process.stdout.write(`Created ${outputPath}\n`);
  }
  if (new Set(outputDurations.map((duration) => duration.toFixed(3))).size !== 1) {
    throw new Error(`Matched demo outputs have different durations: ${outputDurations.join(", ")}`);
  }
}

async function createCapture(theme, setup) {
  const rawDir = resolve(outputDir, `raw-${theme.slug}`);
  rmSync(rawDir, { force: true, recursive: true });
  mkdirSync(rawDir, { recursive: true });
  const context = await browser.newContext({
    colorScheme: theme.colorScheme,
    extraHTTPHeaders: identityHeaders(setup.ownerId, "demo-owner@openfloor.test", "Maya Chen"),
    recordVideo: { dir: rawDir, size: viewport },
    viewport,
  });
  await context.addInitScript((value) => localStorage.setItem("openfloor:theme", value), theme.value);
  const page = await context.newPage();
  return { context, page, theme, video: page.video() };
}

async function prepareSession() {
  const ownerId = "demo-owner";
  const memberId = "demo-member";
  const ownerContext = await browser.newContext({
    extraHTTPHeaders: identityHeaders(ownerId, "demo-owner@openfloor.test", "Maya Chen"),
    viewport,
  });
  const memberContext = await browser.newContext({
    extraHTTPHeaders: identityHeaders(memberId, "demo-member@openfloor.test", "Eli Reyes"),
    viewport,
  });
  await Promise.all([
    onboard(ownerContext, "Maya", "Chen"),
    onboard(memberContext, "Eli", "Reyes"),
  ]);

  const owner = await ownerContext.newPage();
  const memberPage = await memberContext.newPage();
  await owner.goto(`${origin}/app/home`);
  await owner.getByRole("button", { name: "New session" }).click();
  await owner.getByLabel("Session title").fill("Incident command center");
  await owner.getByLabel(/Objective/).fill(sessionObjective);
  await owner.getByRole("button", { name: "Create session" }).click();
  await owner.waitForURL(/\/app\/session\/[0-9a-f-]+$/);

  const inviteUrl = await owner.getByLabel("Active invite link").inputValue();
  await memberPage.goto(`${origin}${new URL(inviteUrl).pathname}`);
  await memberPage.getByRole("button", { name: "Join session" }).click();
  await memberPage.waitForURL(/\/app\/session\/[0-9a-f-]+$/);

  await owner.getByRole("button", { name: "Connect GitHub" }).click();
  await owner.getByRole("combobox", { name: "Connected repository" }).waitFor();
  await owner.getByLabel("Required check commands").fill("npm test\nnpm run typecheck");
  await owner.getByRole("button", { name: "Save repository" }).click();
  await owner.getByRole("button", { name: "Enable execution" }).click();
  await owner.getByLabel("Candidate branch name").fill("Incident command center");
  await owner.getByLabel("Candidate description").fill("Ship the coordinated realtime incident application.");
  await owner.getByRole("button", { name: "Create candidate" }).click();
  await owner.getByText("Execution enabled. Candidate branch created.").waitFor();
  await owner.getByRole("link", { name: "Enter agent floor" }).click();
  await owner.waitForURL(/\/floor$/);

  const floor = owner.getByRole("region", { name: "Agent floor" });
  await createAgent(owner, floor, "Forge", "Backend engineer", "Own incident APIs, persistence, realtime server events, and backend tests.", "Eli R.");

  const team = owner.getByRole("region", { name: "Team" });
  await team.getByLabel("Assignment for Maya C.").fill("Own the frontend dashboard, realtime UI, and release integration.");
  await team.getByLabel("Assignment for Maya C.").blur();
  await team.getByLabel("Assignment for Eli R.").fill("Own API contracts, persistence, event delivery, and backend coverage.");
  await team.getByLabel("Assignment for Eli R.").blur();

  const floorUrl = owner.url();
  await memberPage.goto(floorUrl, { waitUntil: "networkidle" });
  await memberPage.getByRole("heading", { name: "Agent floor" }).waitFor();
  await ownerContext.close();
  return { floorUrl, memberContext, memberPage, ownerId };
}

async function createAgent(page, floor, name, role, task, ownerName) {
  await floor.getByRole("button", { name: "New agent" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await dialog.getByLabel("Role", { exact: true }).fill(role);
  await dialog.getByLabel("Task", { exact: true }).fill(task);
  if (ownerName) {
    await dialog.getByRole("combobox", { name: "Agent owner" }).click();
    await dialog.getByRole("option", { name: ownerName }).click();
  }
  await dialog.getByRole("button", { name: "Create agent" }).click();
  await dialog.waitFor({ state: "hidden" });
}

async function onboard(context, firstName, lastName) {
  const response = await context.request.post(`${origin}/app/api/account/onboarding`, {
    multipart: { firstName, lastName, plan: "free", returnTo: "/app/home" },
  });
  if (!response.ok()) throw new Error(`Onboarding failed with ${response.status()}`);
}

function identityHeaders(id, email, name) {
  return {
    "x-openfloor-dev-user-id": id,
    "x-openfloor-dev-user-email": email,
    "x-openfloor-dev-user-name": name,
  };
}

async function camera(page, originValue, scale) {
  await page.evaluate(({ originValue, scale }) => {
    document.body.style.transformOrigin = originValue;
    document.body.style.transition = "transform 650ms cubic-bezier(0.22, 1, 0.36, 1)";
    document.body.style.transform = `scale(${scale})`;
  }, { originValue, scale });
  await pause(page, 700);
}

async function cameraAll(pages, originValue, scale) {
  await Promise.all(pages.map((page) => camera(page, originValue, scale)));
}

async function pauseAll(pages, milliseconds) {
  await Promise.all(pages.map((page) => pause(page, milliseconds)));
}

async function pause(page, milliseconds) {
  await page.waitForTimeout(milliseconds);
}

async function waitForQueueLifecycle(items, onStatus) {
  for (const status of ["provisioning", "running", "checking", "ready", "publishing", "published", "integrating", "integrated"]) {
    await Promise.all(items.map((item) => item.getByText(status, { exact: true }).waitFor({ timeout: 30_000 })));
    await onStatus?.(status);
  }
}

async function assertConcurrentTyping(inputs, status) {
  for (const input of inputs) {
    const value = await input.inputValue();
    if (value.length === 0 || value === mayaPrompt) {
      throw new Error(`Maya must still be typing while Eli's queue item is ${status}`);
    }
  }
}

async function expectPressed(locator) {
  await locator.waitFor();
  if (await locator.getAttribute("aria-pressed") !== "true") {
    throw new Error(`Expected ${await locator.textContent()} to remain pressed`);
  }
}

async function assertAgentCardLayout(page) {
  await page.locator("article.agent-card").evaluateAll((cards) => {
    for (const card of cards) {
      const identity = card.querySelector(".agent-identity");
      const trailing = card.querySelector(".agent-head-trailing");
      if (!identity || !trailing) throw new Error("Agent card header is incomplete");
      if (identity.getBoundingClientRect().right > trailing.getBoundingClientRect().left + 0.5) {
        throw new Error("Agent identity overlaps its status controls");
      }
      for (const selector of [".agent-identity strong", ".agent-identity > span", ".agent-foot > span"]) {
        for (const element of card.querySelectorAll(selector)) {
          if (element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1) {
            throw new Error(`Agent card metadata is clipped: ${element.textContent}`);
          }
        }
      }
    }
  });
}

async function assertTopBarLayout(page) {
  await page.locator(".topbar").evaluate((topbar) => {
    const brand = topbar.querySelector(".brand");
    const sessionPath = topbar.querySelector(".session-path");
    const repository = topbar.querySelector(".repo-branch");
    const branch = repository?.querySelector("code");
    const objective = topbar.querySelector(".objective-inline");
    if (!brand || !sessionPath || !repository || !branch || !objective) throw new Error("Top bar context is incomplete");
    if (brand.scrollWidth > brand.clientWidth + 1 || brand.getBoundingClientRect().right > sessionPath.getBoundingClientRect().left + 0.5) {
      throw new Error("Top bar brand overlaps the session path");
    }
    if ((branch.textContent?.length ?? 0) > 28) throw new Error("Top bar branch is not abbreviated");
    if (repository.getBoundingClientRect().right > objective.getBoundingClientRect().left + 0.5) {
      throw new Error("Top bar branch overlaps the session objective");
    }
  });
}

async function readAgentCardHeights(page) {
  return page.locator("article.agent-card").evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().height));
}

async function assertAgentCardHeights(pages, expectedByPage, status) {
  for (const [index, page] of pages.entries()) {
    const current = await readAgentCardHeights(page);
    if (current.length !== expectedByPage[index].length || current.some((height, cardIndex) => Math.abs(height - expectedByPage[index][cardIndex]) > 0.5)) {
      throw new Error(`Agent card height changed while run status was ${status}`);
    }
  }
}

function transcode(inputPath, outputPath, duration) {
  const result = spawnSync("ffmpeg", [
    "-y", "-loglevel", "error", "-i", inputPath,
    "-t", duration.toFixed(6),
    "-an", "-vf", "fps=30,format=yuv420p",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18",
    "-movflags", "+faststart", outputPath,
  ], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("ffmpeg could not create the website MP4");
}

function verifyDuration(outputPath) {
  return readDuration(outputPath);
}

function readDuration(path) {
  const result = spawnSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", path,
  ], { encoding: "utf8" });
  const duration = Number.parseFloat(result.stdout);
  if (!Number.isFinite(duration)) throw new Error(`Could not read duration for ${path}`);
  return duration;
}

async function waitForServer() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode != null) throw new Error(`Local demo server exited with ${server.exitCode}`);
    try {
      const response = await fetch(`${origin}/app`);
      if (response.ok) return;
    } catch {
      // The local Worker is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error("Timed out waiting for the local demo server");
}

function demoFile(path, summary, lines) {
  return {
    path,
    changeKind: "add",
    additions: lines.length,
    deletions: 0,
    summary,
    diff: `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`,
  };
}
