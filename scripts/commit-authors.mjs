/** Executed only in the trusted publisher, independently of repository metadata. */
export function commitAuthors(json) {
  if (!json || json === "null") return [];
  const values = JSON.parse(json);
  if (!Array.isArray(values)) throw new Error("Invalid commit authors");
  const authors = new Map();
  for (const value of values) {
    if (!value || typeof value.id !== "string" || !/^[1-9][0-9]{0,19}$/.test(value.id) ||
        typeof value.login !== "string" || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(value.login)) throw new Error("Invalid commit authors");
    if (!authors.has(value.id)) authors.set(value.id, { name: value.login, email: `${value.id}+${value.login}@users.noreply.github.com` });
  }
  return [...authors.values()];
}
