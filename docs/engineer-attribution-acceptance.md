# Engineer attribution acceptance

After the release PR is accepted and deployed to development, use a disposable GitHub repository and two authenticated engineers.

1. In each account's Settings → Connections, refresh GitHub access. Confirm the displayed personal account is correct, including when the installed App belongs to an organization.
2. As the owner, create a session and agent. Invite the second engineer and have that engineer submit a code-changing prompt to the owner's agent.
3. Allow the run to integrate. In Run History and Review, confirm the second engineer is shown as the prompter, alongside the software agent and a GitHub commit link.
4. Follow that link. Confirm the commit author is the second engineer, the author email is the GitHub ID-based noreply address, and openfloor remains committer. The dispatcher must not receive author credit merely for starting the run.
5. Submit independent work from the owner. Confirm both engineers' changes appear under their existing Review engineer filters. Roll back the owner's disposable contribution and confirm it remains in history but is excluded from active squash credit.
6. Mark the PR ready and squash merge through openfloor. Confirm the resulting base-branch commit credits only the remaining contributor. Adding a noncontributing member must not add co-author credit.
7. For an account created before identity capture, confirm code prompts wait with verification guidance while eligible teammates' work continues. Refresh GitHub access in Settings and confirm waiting work resumes. Read-only replies remain available before verification.
8. Reload History and Review. Confirm names, profile links, and commit links persist. Old commits remain unchanged and legacy runs do not claim newly recorded Git authorship.

Automated coverage additionally exercises multi-prompt co-authors, deterministic retries, rejected forged identities, resolver inheritance, contributors outside the latest-20 window, and deleted-user audit behavior. App-driven squash is required for the contributor policy; a merge performed directly on GitHub uses GitHub's own chosen message.

Rollback keeps the nullable columns. Drain attributed publication attempts before reverting the publisher; its old bot identity would produce a different SHA. Do not rewrite published history.
