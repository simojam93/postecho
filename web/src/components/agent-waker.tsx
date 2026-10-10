"use client";

import { useEffect } from "react";
import { agentWakePort, startAgentWake } from "@/lib/agent-wake";

const PORT = agentWakePort(process.env.NEXT_PUBLIC_AGENT_WAKE_PORT);

/**
 * Wakes the agent on the owner's computer while PostEcho is open, and after
 * each request that made a job (lib/agent-wake.ts). Mounted once, in the app
 * shell of every authenticated page. Renders nothing.
 */
export function AgentWaker() {
  useEffect(() => startAgentWake({ port: PORT, win: window, doc: document }), []);
  return null;
}
