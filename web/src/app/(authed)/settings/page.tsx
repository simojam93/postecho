import { SettingsPanel } from "@/components/settings/settings-panel";

/**
 * /settings: the same panel the cog opens as a window (components/settings,
 * 2026-09-25), as a page — for a bookmark or a link from outside the app.
 */
export default function SettingsPage() {
  return <SettingsPanel mode="page" />;
}
