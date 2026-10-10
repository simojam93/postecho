import type { Logger } from "./worker.js";

/** While awake the agent heartbeats this often, so the app shows it online (it calls it offline after 3 minutes). */
export const HEARTBEAT_EVERY_MS = 2 * 60_000;

export type TimerHandle = ReturnType<typeof setTimeout>;

/** The clock and timers, injected so the tests drive time. */
export type Clock = {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
};

export type WakeControllerOptions = {
  /** Claims until there are none (worker.ts's drain). isStopping turns true once the agent is stopping. */
  drain: (isStopping: () => boolean) => Promise<void>;
  /** One heartbeat; false when it failed. */
  heartbeat: () => Promise<boolean>;
  /** How long the agent stays awake after the page's last request (AGENT_AWAKE_MINUTES). */
  awakeMs: number;
  /** How often the asleep agent claims anyway (AGENT_IDLE_CHECK_MINUTES); 0 means never. */
  idleCheckMs: number;
  clock?: Clock;
  logger?: Logger;
};

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

/**
 * When the agent talks to the web app, in wake mode (see
 * docs/specs/2026-10-10-agent-wakes-on-demand-design.md).
 *
 * - Asleep by default: no claims, no heartbeat.
 * - `awake()` (the page is open) and `wake()` (the page just made a job) wake
 *   it for awakeMs from now, heartbeat if the last one is 2 minutes old, and
 *   claim until there are none.
 * - Awake and idle, it only heartbeats every 2 minutes. When the time is up it
 *   sleeps, after the job in hand is finished and reported.
 * - A request during a claim run asks for one more run after it, so a job made
 *   just after the last empty claim isn't left waiting.
 * - With idleCheckMs, the asleep agent claims every that many milliseconds.
 */
export function createWakeController(opts: WakeControllerOptions) {
  const clock = opts.clock ?? realClock;
  const logger = opts.logger ?? console;

  let isAwake = false;
  let stopping = false;
  let awakeUntil = 0;
  let lastHeartbeatAt = -Infinity;
  let heartbeating: Promise<void> | null = null;
  let draining: Promise<void> | null = null;
  let again = false;
  let sleepTimer: TimerHandle | null = null;
  let heartbeatTimer: TimerHandle | null = null;
  let idleTimer: TimerHandle | null = null;

  const clear = (timer: TimerHandle | null) => {
    if (timer) clock.clearTimeout(timer);
    return null;
  };

  function heartbeatIfDue(): void {
    if (stopping || heartbeating || clock.now() - lastHeartbeatAt < HEARTBEAT_EVERY_MS) return;
    // The attempt counts, so a failing heartbeat is retried in 2 minutes rather than at once.
    lastHeartbeatAt = clock.now();
    heartbeating = opts
      .heartbeat()
      .then(() => undefined, () => undefined)
      .finally(() => { heartbeating = null; });
  }

  function scheduleHeartbeat(): void {
    heartbeatTimer = clear(heartbeatTimer);
    if (!isAwake || stopping) return;
    const wait = Math.max(0, lastHeartbeatAt + HEARTBEAT_EVERY_MS - clock.now());
    heartbeatTimer = clock.setTimeout(() => {
      heartbeatTimer = null;
      heartbeatIfDue();
      scheduleHeartbeat();
    }, wait);
  }

  function scheduleIdleCheck(): void {
    idleTimer = clear(idleTimer);
    if (isAwake || stopping || opts.idleCheckMs <= 0) return;
    idleTimer = clock.setTimeout(() => {
      idleTimer = null;
      void requestDrain();
      scheduleIdleCheck();
    }, opts.idleCheckMs);
  }

  function goToSleep(): void {
    isAwake = false;
    sleepTimer = clear(sleepTimer);
    heartbeatTimer = clear(heartbeatTimer);
    logger.log("[agent] asleep until PostEcho is opened");
    scheduleIdleCheck();
  }

  function timeUp(): void {
    sleepTimer = null;
    if (clock.now() < awakeUntil) {
      sleepTimer = clock.setTimeout(timeUp, awakeUntil - clock.now());
      return;
    }
    // A job in hand is finished and reported first: the drain sends the agent to sleep when it ends.
    if (!draining) goToSleep();
  }

  function wakeUp(): void {
    awakeUntil = clock.now() + opts.awakeMs;
    if (!isAwake) {
      isAwake = true;
      idleTimer = clear(idleTimer);
      logger.log("[agent] awake: PostEcho is open");
    }
    sleepTimer = clear(sleepTimer);
    sleepTimer = clock.setTimeout(timeUp, opts.awakeMs);
    heartbeatIfDue();
    scheduleHeartbeat();
  }

  function requestDrain(): Promise<void> {
    if (stopping) return Promise.resolve();
    if (draining) {
      again = true;
      return draining;
    }
    draining = (async () => {
      try {
        do {
          again = false;
          await opts.drain(() => stopping);
        } while (again && !stopping);
      } catch (e) {
        logger.error(`[agent] claiming jobs failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        draining = null;
        if (isAwake && !stopping && clock.now() >= awakeUntil) goToSleep();
      }
    })();
    return draining;
  }

  /** The page asked: wake (or stay awake), then claim until there are none. */
  function onPageRequest(): Promise<void> {
    if (stopping) return Promise.resolve();
    wakeUp();
    return requestDrain();
  }

  return {
    /** Arms the idle check. The agent starts asleep. */
    start(): void {
      scheduleIdleCheck();
    },
    /** POST /awake: PostEcho is open. */
    awake: onPageRequest,
    /** POST /wake: the page just made a job. */
    wake: onPageRequest,
    /** GET /status. */
    status(): { awake: boolean; busy: boolean } {
      return { awake: isAwake, busy: draining !== null };
    },
    /** No more timers or claims; resolves once the job in hand is finished and reported. */
    async stop(): Promise<void> {
      stopping = true;
      sleepTimer = clear(sleepTimer);
      heartbeatTimer = clear(heartbeatTimer);
      idleTimer = clear(idleTimer);
      await Promise.all([draining, heartbeating]);
    },
  };
}

export type WakeController = ReturnType<typeof createWakeController>;
