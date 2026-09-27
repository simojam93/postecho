import { redirect } from "next/navigation";
import { db } from "@/db";
import { getSession } from "@/lib/session";
import { getSetting } from "@/lib/settings";
import { seenHints } from "@/lib/setup";
import { AppShell } from "@/components/app-shell";
import { HintsProvider } from "@/components/onboarding/tab-hints";
import { WelcomeHost } from "@/components/onboarding/welcome";
import { SettingsProvider } from "@/components/settings/settings-provider";

export default async function AuthedLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session.loggedIn) redirect("/login");
  // The welcome shows once, after the first login (2026-09-26). A db hiccup
  // here never blocks the app: the welcome and the tabs' hints just don't
  // show, the name is blank.
  const [onboardedAt, name, hintsSeen, styleProposal] = await Promise.all([
    getSetting(db, "onboardedAt").catch(() => "unknown"),
    getSetting(db, "identityName").catch(() => ""),
    seenHints(db).catch(() => ["sources", "settings", "videos"] as const),
    // A style guide update waiting for the owner (lib/style-learning.ts): the cog shows it.
    getSetting(db, "styleProposal").catch(() => null),
  ]);

  return (
    // The hints wrap Settings too: its window opens on Start here the first time.
    <HintsProvider seen={[...hintsSeen]}>
      <SettingsProvider suggestion={styleProposal !== null}>
        <AppShell name={name}>{children}</AppShell>
        <WelcomeHost openOnStart={!onboardedAt} />
      </SettingsProvider>
    </HintsProvider>
  );
}
