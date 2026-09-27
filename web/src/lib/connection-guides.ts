/**
 * Every connection explained step by step (owner, 2026-09-26: "ogni
 * collegamento anche con AI tools va tutto spiegato step by step sia
 * nell'onboarding che poi nelle sources dei settings"). The same guides back
 * the welcome's Connect step, Settings › Sources and Settings › AI tools.
 * Plain words; links go to the exact page where the key is made.
 */

export type GuideStep = { text: string; link?: { label: string; href: string }; code?: string };
export type GuideField = { name: string; label: string; placeholder: string; secret: boolean };

export type KeyGuide = {
  id: "jev" | "bluesky" | "youtube" | "producthunt";
  name: string;
  /** What it adds, in one line. */
  what: string;
  /** Free, or what it costs. */
  cost: string;
  steps: GuideStep[];
  fields: GuideField[];
};

export const KEY_GUIDES: Record<KeyGuide["id"], KeyGuide> = {
  jev: {
    id: "jev",
    name: "Jev",
    what: "Ranks what you find, scores how human a post reads, and picks the best takes.",
    cost: "Paid per use, a few cents a search: see typesafe.ai for prices.",
    steps: [
      { text: "Sign in to the TypeSafe console, or create an account.", link: { label: "console.typesafe.ai", href: "https://console.typesafe.ai" } },
      { text: "Create an API key there." },
      { text: "Paste it below and press Connect: PostEcho checks it right away." },
    ],
    fields: [{ name: "TYPESAFE_API_KEY", label: "API key", placeholder: "Your TypeSafe API key", secret: true }],
  },
  bluesky: {
    id: "bluesky",
    name: "Bluesky",
    what: "Posts from Bluesky in your searches.",
    cost: "Free.",
    steps: [
      { text: "Sign in to Bluesky, or create a free account.", link: { label: "bsky.app", href: "https://bsky.app" } },
      { text: "Open Settings › Privacy and security › App passwords, and add one called PostEcho.", link: { label: "App passwords", href: "https://bsky.app/settings/app-passwords" } },
      { text: "Paste your handle and the app password below. Never your account password." },
    ],
    fields: [
      { name: "BLUESKY_IDENTIFIER", label: "Handle", placeholder: "you.bsky.social", secret: false },
      { name: "BLUESKY_APP_PASSWORD", label: "App password", placeholder: "xxxx-xxxx-xxxx-xxxx", secret: true },
    ],
  },
  youtube: {
    id: "youtube",
    name: "YouTube",
    what: "Videos from YouTube in your searches.",
    cost: "Free: the daily quota is plenty for PostEcho.",
    steps: [
      { text: "Open the Google Cloud console and create a project, or pick one.", link: { label: "console.cloud.google.com", href: "https://console.cloud.google.com/projectcreate" } },
      { text: "Enable the YouTube Data API v3 for that project.", link: { label: "YouTube Data API v3", href: "https://console.cloud.google.com/apis/library/youtube.googleapis.com" } },
      { text: "In APIs & Services › Credentials, press Create credentials › API key.", link: { label: "Credentials", href: "https://console.cloud.google.com/apis/credentials" } },
      { text: "Paste the key below and press Connect." },
    ],
    fields: [{ name: "YOUTUBE_API_KEY", label: "API key", placeholder: "AIza…", secret: true }],
  },
  producthunt: {
    id: "producthunt",
    name: "Product Hunt",
    what: "Launches from Product Hunt in your searches.",
    cost: "Free.",
    steps: [
      { text: "Sign in to Product Hunt, then open the API dashboard.", link: { label: "API dashboard", href: "https://www.producthunt.com/v2/oauth/applications" } },
      { text: "Add an application: any name, and https://localhost as the redirect URI." },
      { text: "On the application's page, create a Developer Token." },
      { text: "Paste the token below and press Connect." },
    ],
    fields: [{ name: "PRODUCTHUNT_TOKEN", label: "Developer token", placeholder: "Your developer token", secret: true }],
  },
};

/** The Mac agent's setup, step by step; the `.env` command is filled in with this site's address and token when shown. */
export function claudeSteps(envCommand: string | null): GuideStep[] {
  return [
    {
      text: "Install Claude Code on your Mac: open Terminal and paste this. It needs a Claude Pro, Max, Team or Enterprise plan.",
      code: "curl -fsSL https://claude.ai/install.sh | bash",
      link: { label: "Claude Code setup", href: "https://code.claude.com/docs/en/setup" },
    },
    { text: "Log in: type claude, press Enter, and follow the browser.", code: "claude" },
    {
      text: "Get PostEcho's agent (it needs Node.js 20 or later and git).",
      code: "git clone https://github.com/simojam93/PostEcho.git && cd PostEcho/agent && npm install",
      link: { label: "Node.js", href: "https://nodejs.org" },
    },
    {
      text: "Connect it to this PostEcho: in the same folder, paste this. It writes the agent's settings file.",
      code: envCommand ?? undefined,
    },
    { text: "Check it, then start it. This window turns green by itself when your Mac says hello.", code: "npm run doctor && npm run dev" },
    { text: "To keep it running without a Terminal window, follow “Running as a background daemon” in agent/README.md." },
  ];
}

/** The command that writes the agent's `.env` with the two lines it needs. */
export function agentEnvCommand(url: string, token: string): string {
  return `cat > .env <<'EOF'\nPOSTECHO_URL=${url}\nAGENT_TOKEN=${token}\nEOF`;
}
