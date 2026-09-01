import { spawnSync } from "node:child_process";

const DATABASE = "openfloor-production";
const args = process.argv.slice(2);
const command = args[0];
const remote = args.includes("--remote");
const local = args.includes("--local");

if (!command || (remote && local) || !["list", "grant", "revoke", "resync"].includes(command)) usage();
const scope = remote ? "--remote" : "--local";

if (command === "list") {
  requireArity(1);
  const rows = execute(`
    SELECT w.id AS record_id, w.created_at AS submitted_at, w.updated_at,
      w.name, w.email, w.status, w.sheet_sync_state, w.sheet_sync_attempts,
      w.sheet_next_attempt_at, w.sheet_last_error,
      CASE WHEN u.early_access_granted_at IS NOT NULL AND u.early_access_revoked_at IS NULL THEN 1 ELSE 0 END AS account_admitted
    FROM early_access_waitlist w
    LEFT JOIN users u ON u.email = w.email AND u.deleted_at IS NULL
    ORDER BY w.created_at DESC;
  `);
  console.table(rows);
  process.exit(0);
}

requireArity(2);
const email = normalizeEmail(args[1]);
if (!email) fail("Provide a valid email address.");
const quotedEmail = quote(email);

if (command === "resync") {
  const rows = execute(`
    UPDATE early_access_waitlist
    SET sheet_sync_state = 'pending', sheet_sync_attempts = 0,
      sheet_next_attempt_at = ${Date.now()}, sheet_last_error = NULL, sheet_synced_at = NULL
    WHERE email = ${quotedEmail}
    RETURNING id AS record_id, email, sheet_sync_state;
  `);
  if (rows.length === 0) fail(`No waitlist record exists for ${email}.`);
  console.table(rows);
  process.exit(0);
}

const users = execute(`SELECT id, email, display_name FROM users WHERE email = ${quotedEmail} AND deleted_at IS NULL LIMIT 1;`);
if (users.length === 0) fail(`No authenticated openfloor account exists for ${email}. Send the shared beta passcode instead.`);
const userId = quote(String(users[0].id));
const now = Date.now();

if (command === "grant") {
  const rows = execute(`
    UPDATE users
    SET early_access_granted_at = ${now}, early_access_revoked_at = NULL,
      early_access_grant_source = 'manual', updated_at = ${now}
    WHERE id = ${userId} AND deleted_at IS NULL
    RETURNING id, email, display_name, early_access_granted_at, early_access_grant_source;
    UPDATE early_access_waitlist
    SET status = 'admitted', sheet_sync_state = 'pending', sheet_sync_attempts = 0,
      sheet_next_attempt_at = ${now}, sheet_last_error = NULL, sheet_synced_at = NULL, updated_at = ${now}
    WHERE email = ${quotedEmail};
  `);
  console.table(rows.filter((row) => row.early_access_granted_at != null));
  process.exit(0);
}

const rows = execute(`
  UPDATE users
  SET early_access_revoked_at = ${now}, updated_at = ${now}
  WHERE id = ${userId} AND deleted_at IS NULL
  RETURNING id, email, display_name, early_access_granted_at, early_access_revoked_at;
`);
console.table(rows);

function execute(sql) {
  const result = spawnSync("npx", ["wrangler", "d1", "execute", DATABASE, scope, "--command", sql, "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) fail(result.stderr.trim() || result.stdout.trim() || "Wrangler D1 command failed.");
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { fail(`Wrangler returned invalid JSON:\n${result.stdout}`); }
  const batches = Array.isArray(parsed) ? parsed : [parsed];
  return batches.flatMap((batch) => Array.isArray(batch?.results) ? batch.results : []);
}

function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  return normalized.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : null;
}

function quote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function requireArity(expected) {
  const positional = args.filter((value) => value !== "--remote" && value !== "--local");
  if (positional.length !== expected) usage();
}

function usage() {
  console.error("Usage: npm run early-access -- <list|grant EMAIL|revoke EMAIL|resync EMAIL> [--remote|--local]");
  process.exit(2);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
