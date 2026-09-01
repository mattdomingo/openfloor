const WAITLIST_TAB = "Waitlist";
const WEBHOOK_SECRET_PROPERTY = "WAITLIST_SHEET_WEBHOOK_SECRET";
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;
const RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const HEADERS = ["Record ID", "Submitted At", "Updated At", "Name", "Email", "Status"];

function doPost(event) {
  try {
    const request = JSON.parse(event.postData.contents);
    if (!isValidSignedRequest(request)) return jsonResponse({ ok: false, error: "unauthorized" });
    const record = JSON.parse(request.payload);
    if (!isValidRecord(record)) return jsonResponse({ ok: false, error: "invalid_record" });
    upsertWaitlistRow(record);
    return jsonResponse({ ok: true });
  } catch (error) {
    console.error(error);
    return jsonResponse({ ok: false, error: "request_failed" });
  }
}

function isValidSignedRequest(request) {
  if (!request || typeof request.timestamp !== "number" || typeof request.payload !== "string" || typeof request.signature !== "string") return false;
  if (Math.abs(Date.now() - request.timestamp) > MAX_SIGNATURE_AGE_MS) return false;
  const secret = PropertiesService.getScriptProperties().getProperty(WEBHOOK_SECRET_PROPERTY);
  if (!secret) throw new Error("Missing Apps Script webhook secret property.");
  const bytes = Utilities.computeHmacSha256Signature(`${request.timestamp}.${request.payload}`, secret);
  const expected = bytes.map((byte) => (byte < 0 ? byte + 256 : byte).toString(16).padStart(2, "0")).join("");
  return constantTimeEqual(expected, request.signature.toLowerCase());
}

function constantTimeEqual(left, right) {
  let mismatch = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return mismatch === 0;
}

function isValidRecord(record) {
  return record && typeof record.id === "string" && record.id.length > 0
    && typeof record.submittedAt === "number" && typeof record.updatedAt === "number"
    && typeof record.name === "string" && record.name.length > 0
    && typeof record.email === "string" && record.email.length > 0
    && (record.status === "waiting" || record.status === "admitted");
}

function upsertWaitlistRow(record) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = requiredSheet();
    ensureHeaders(sheet);
    const lastRow = sheet.getLastRow();
    const ids = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat() : [];
    const index = ids.findIndex((id) => String(id) === record.id);
    const row = [record.id, new Date(record.submittedAt), new Date(record.updatedAt), record.name, record.email, record.status];
    if (index >= 0) sheet.getRange(index + 2, 1, 1, HEADERS.length).setValues([row]);
    else sheet.appendRow(row);
  } finally {
    lock.releaseLock();
  }
}

function purgeExpiredWaitlistRows() {
  const sheet = requiredSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;
  const cutoff = Date.now() - RETENTION_MS;
  const updated = sheet.getRange(2, 3, lastRow - 1, 1).getValues();
  for (let index = updated.length - 1; index >= 0; index -= 1) {
    const value = updated[index][0];
    const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
    if (Number.isFinite(timestamp) && timestamp < cutoff) sheet.deleteRow(index + 2);
  }
}

function ensureHeaders(sheet) {
  const current = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  if (current.every((value, index) => value === HEADERS[index])) return;
  if (sheet.getLastRow() > 0 && current.some((value) => value !== "")) throw new Error("Waitlist tab headers do not match the required schema.");
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  sheet.setFrozenRows(1);
}

function requiredSheet() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(WAITLIST_TAB);
  if (!sheet) throw new Error(`Missing ${WAITLIST_TAB} tab.`);
  return sheet;
}

function jsonResponse(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}
