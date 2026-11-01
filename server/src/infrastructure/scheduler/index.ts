import { Elysia } from 'elysia';
import { cron } from '@elysiajs/cron';
import { AwilixContainer } from 'awilix';
import { executeJobUseCase, mutationRuntimeOf } from '../use-case-routes';

/** Registered cron name; this is the key the installed plugin uses in its store. */
const CRON_NAME = 'monthly-recurrence-job';

/**
 * Owned lifecycle for the daily finance timer.
 *
 * `@elysiajs/cron` 1.4.2 registers a live croner handle in
 * `app.store.cron[name]` and has no stop hook of its own, so stopping the
 * process requires the application to hold that exact handle. `stop()` is the
 * only supported shutdown path: it marks the scheduler as stopping
 * synchronously, permanently stops the timer and resolves only after the job
 * that already entered the FIFO mutation runtime has settled. A caller may
 * therefore stop PocketBase afterwards without racing a queued mutation.
 */
export interface SchedulerLifecycle {
  /** True from the first `stop()` call on; no further financial work is enqueued. */
  readonly isStopping: boolean;
  /** Stops the timer once and drains the run already in flight. Idempotent. */
  stop(): Promise<void>;
}

/** Mutable run bookkeeping shared by the timer callback and `stop()`. */
interface SchedulerRunState {
  stopping: boolean;
  inFlight: Promise<void> | null;
}

/**
 * Paired local stations never generate shared recurrence months
 * automatically: the central server owns that cron, and a replicated extra
 * generation would double months (manual explicit advance stays an intent).
 * Standalone local modes and the central BFF run the monthly process.
 */
async function isPairedLocalStation(container: AwilixContainer): Promise<boolean> {
  const runtime = mutationRuntimeOf(container);
  if (runtime.options.role !== 'local') {
    return false;
  }
  const state = await runtime.syncRepository.readStationState();
  return state?.mode === 'station';
}

/**
 * One timer fire. Every financial mutation goes through the same FIFO gate,
 * unit of work and atomic PocketBase batch as an HTTP write; the local role
 * records real canonical child intents. The stopping flag is checked
 * synchronously before each enqueue so a shutdown barrier can never be
 * followed by new queued work that the barrier does not drain.
 */
async function runScheduledJob(
  container: AwilixContainer,
  state: SchedulerRunState,
): Promise<void> {
  try {
    // The barrier check before this enqueue lives in the timer callback: it
    // runs in the same synchronous turn, so `stop()` can never slip between
    // the check and this dispatch.
    console.log('⏰ [SCHEDULER] Starting the scheduled daily job...');
    const reconciliationReport = await executeJobUseCase(container, 'reconcileInvoicesUseCase');
    void reconciliationReport;
    console.log('✅ [SCHEDULER] Reconciliation completed.');

    if (state.stopping) {
      console.log('⏰ [SCHEDULER] Stop requested after reconciliation; skipping shared monthly generation.');
      return;
    }

    if (await isPairedLocalStation(container)) {
      console.log('⏰ [SCHEDULER] Paired local station skipped shared monthly generation (manual advance stays an intent).');
      return;
    }

    // `isPairedLocalStation` awaits PocketBase, so re-check the barrier
    // before queueing the second mutation.
    if (state.stopping) {
      console.log('⏰ [SCHEDULER] Stop requested before the monthly engine; skipping shared monthly generation.');
      return;
    }

    const recurrenceReport = await executeJobUseCase(container, 'processMonthlyRecurrencesUseCase');
    console.log(`✅ [SCHEDULER] Monthly engine completed with ${String(recurrenceReport.processed)} generated occurrence(s).`);
  } catch (error) {
    if (state.stopping) {
      // Teardown interrupted the mutation runtime; no further work is queued.
      console.error('⏰ [SCHEDULER] The scheduled job stopped before completing:', error);
      return;
    }
    console.error('❌ [SCHEDULER ERROR] The recurrence job failed:', error);
  }
}

/**
 * Builds the scheduler plugin together with its typed lifecycle handle.
 *
 * The cron handle is read from the plugin's own Elysia store — the exact
 * object `@elysiajs/cron` registers — so shutdown stops the real timer instead
 * of adding an HTTP route, a second timer or a process-level kill.
 */
export function createScheduler(container: AwilixContainer) {
  const state: SchedulerRunState = { stopping: false, inFlight: null };

  const plugin = new Elysia({ name: 'scheduler' }).use(
    cron({
      name: CRON_NAME,
      pattern: '0 1 * * *', // Every day at 01:00 AM
      timezone: 'America/Fortaleza',
      // A trigger that lands while the previous job is still queued or
      // executing is skipped: two overlapping runs would enqueue duplicate
      // financial work behind the same FIFO gate.
      protect: true,
      run() {
        // Both guards are synchronous with `stop()`'s barrier: a trigger that
        // arrives after the barrier, or while a run is still queued or
        // executing, must not enqueue financial work.
        if (state.stopping) return;
        if (state.inFlight !== null) return;
        const job = runScheduledJob(container, state);
        state.inFlight = job;
        const settle = () => {
          if (state.inFlight === job) state.inFlight = null;
        };
        // Both callbacks resolve, so this derived promise never rejects; the
        // identity check makes a late clear harmless. Attaching after the
        // assignment also covers a job that settles before the call returns.
        void job.then(settle, settle);
        return job;
      },
    }),
  );

  // Registered synchronously by the plugin's store factory; failing loudly is
  // better than running a timer that shutdown could never stop.
  const cronHandle: { stop(): void } | undefined = plugin.store.cron?.[CRON_NAME];
  if (cronHandle === undefined) {
    throw new Error('The scheduler cron handle was not registered by @elysiajs/cron.');
  }

  let stopPromise: Promise<void> | null = null;

  const lifecycle: SchedulerLifecycle = {
    get isStopping() {
      return state.stopping;
    },
    stop(): Promise<void> {
      if (stopPromise !== null) return stopPromise;
      // Synchronous barrier: from here on the timer callback returns early and
      // no branch of a running job may enqueue another mutation.
      state.stopping = true;
      stopPromise = (async () => {
        let stopError: unknown;
        try {
          cronHandle.stop();
        } catch (error) {
          stopError = error;
        }
        // Drain the run that already holds (or waits for) the FIFO gate even
        // when the timer handle itself failed to stop.
        const inFlight = state.inFlight;
        if (inFlight !== null) await inFlight;
        if (stopError !== undefined) throw stopError;
      })();
      return stopPromise;
    },
  };

  return { plugin, lifecycle };
}
