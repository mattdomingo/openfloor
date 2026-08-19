export function githubGitAuthorization(token: string): string {
  if (!token || /[\r\n]/.test(token)) throw new TypeError("Invalid GitHub installation token");
  return `Authorization: Basic ${btoa(`x-access-token:${token}`)}`;
}
