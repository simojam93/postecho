/** Ends the session and goes to the login page (Settings › bottom left, 2026-09-27). */
export async function signOut(): Promise<void> {
  try {
    await fetch("/api/logout", { method: "POST" });
  } finally {
    // A hard navigation (not router.push) is deliberate: it guarantees no
    // client-side state/cache from the authed app survives past session
    // destruction, at the cost of the eslint-plugin-next SPA-navigation warning.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/login");
  }
}
