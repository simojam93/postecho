import type { ReactNode } from "react";
import { AccountBar } from "@/components/account-bar";
import { AgentWaker } from "@/components/agent-waker";
import { BrandMark } from "@/components/brand-mark";
import { Nav } from "@/components/nav";
import { SettingsButton } from "@/components/settings/settings-provider";

/**
 * The app's frame: the sidebar (logo, tabs, the account bar with the cog at its
 * foot) and the page beside it. From md up the sidebar stays put and only the
 * page scrolls (owner, 2026-09-27: "questa fammela fissa, si scrolla solo la
 * parte a destra di ogni tab"). On a phone the sidebar is the header, so the cog
 * stays by the logo there. AgentWaker wakes the agent on the owner's computer
 * while the app is open.
 */
export function AppShell({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-6 p-4 md:flex-row md:p-8">
      <aside className="flex shrink-0 flex-col md:sticky md:top-8 md:h-[calc(100dvh_-_4rem)] md:w-48">
        <div className="mb-6 flex items-center gap-2 px-3 text-lg font-bold tracking-tight">
          <BrandMark />
          <span><span className="text-text-dim">Post</span>Echo</span>
          <SettingsButton className="ml-auto md:hidden" />
        </div>
        <Nav />
        <div className="mt-auto hidden md:block">
          <AccountBar name={name} />
        </div>
      </aside>
      <main className="min-w-0 flex-1">{children}</main>
      <AgentWaker />
    </div>
  );
}
