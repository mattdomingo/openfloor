import { ProviderCredentials } from "./ProviderCredentials";
import type { CredentialProvider, ProviderCredentialSummary } from "@/lib/provider-credentials";

// The lobby-tile twin of session setup's step 2: same per-user credentials,
// same ProviderCredentials list, just reachable without reopening the
// dialog. Credentials are per-user (not per-session), so unlike Skills/Tools
// this renders for every member, not just the owner.
export function ModelConnectionCard({
  initialCredentials,
  providers,
}: {
  initialCredentials: ProviderCredentialSummary[];
  providers: CredentialProvider[];
}) {
  return (
    <section className="action-card" aria-label="AI connection">
      <p className="eyebrow">Model access</p>
      <h2>AI connection</h2>
      <p>
        A run uses the key connected by that agent&rsquo;s owner, then the configured server key. Stored values are
        encrypted and never returned to the browser.
      </p>
      <ProviderCredentials initialCredentials={initialCredentials} providers={providers} showAgentDefaults />
    </section>
  );
}
