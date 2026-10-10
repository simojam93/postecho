import { createWakeController, type WakeController } from "./wake.js";
import { startWakeServer } from "./wake-server.js";
import { runPollLoop, type Logger, type Worker } from "./worker.js";

/** What runAgentLoop needs from a listening server. */
type ClosableServer = { close: () => unknown; closeAllConnections?: () => void };

export type RunAgentLoopOptions = {
  worker: Worker;
  /** AGENT_WAKE_PORT; 0 polls as before. */
  wakePort: number;
  /** The web app's origin, the only one the wake server answers. */
  origin: string;
  awakeMs: number;
  idleCheckMs: number;
  pollIdleSeconds: number;
  /** True once SIGINT/SIGTERM arrived; checked between jobs. */
  isStopping: () => boolean;
  /** Resolves when SIGINT/SIGTERM arrives. */
  stopped: Promise<void>;
  startServer?: (opts: {
    port: number;
    origin: string;
    controller: Pick<WakeController, "awake" | "wake" | "status">;
    logger?: Logger;
  }) => Promise<ClosableServer | null>;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
};

/**
 * Runs until the agent is told to stop, in one of two modes:
 *
 * - **wake**: a wake server on 127.0.0.1:wakePort, and the agent asleep until
 *   the page asks (wake.ts). On stop the server closes and the job in hand is
 *   finished and reported.
 * - **poll**: AGENT_WAKE_PORT=0, or the port is taken: the poll loop as before
 *   (worker.ts's runPollLoop).
 */
export async function runAgentLoop(opts: RunAgentLoopOptions): Promise<"wake" | "poll"> {
  const logger = opts.logger ?? console;
  const poll = async () => {
    await runPollLoop({ worker: opts.worker, isStopping: opts.isStopping, pollIdleSeconds: opts.pollIdleSeconds, sleep: opts.sleep });
    return "poll" as const;
  };
  if (opts.wakePort === 0) return poll();

  const controller = createWakeController({
    drain: (isStopping) => opts.worker.drain(isStopping),
    heartbeat: () => opts.worker.heartbeat(),
    awakeMs: opts.awakeMs,
    idleCheckMs: opts.idleCheckMs,
    logger,
  });
  const startServer = opts.startServer ?? startWakeServer;
  const server = await startServer({ port: opts.wakePort, origin: opts.origin, controller, logger });
  if (!server) return poll();

  controller.start();
  logger.log(`[agent] asleep until PostEcho is opened (it wakes the agent on 127.0.0.1:${opts.wakePort})`);
  await opts.stopped;
  server.close();
  server.closeAllConnections?.();
  await controller.stop();
  return "wake";
}
