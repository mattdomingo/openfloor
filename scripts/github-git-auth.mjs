export function githubGitAuthorization(token) {
  if (typeof token !== "string" || token.length === 0 || /[\r\n]/.test(token)) {
    throw new Error("Invalid GitHub installation token");
  }
  return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`;
}
