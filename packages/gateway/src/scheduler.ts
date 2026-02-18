/**
 * Heartbeat Scheduler — cron-like scheduler that triggers the agent proactively.
 *
 * Each heartbeat has:
 * - A name (for identification)
 * - A cron schedule (e.g., "0 8 * * 1-5" for 8am weekdays)
 * - A prompt (what to tell the agent when the heartbeat fires)
 * - An enabled flag (can be toggled via Telegram commands)
 *
 * When a heartbeat fires:
 * 1. A new session is created with the specified prompt
 * 2. The session goes through the normal orchestrator loop
 * 3. The HITL approval gate is NOT bypassed — heartbeats still need approval
 *    for dangerous actions
 * 4. The response is sent to the user via the bridge
 *
 * Uses cron-parser for schedule parsing.
 *
 * Phase 5: Initial implementation.
 */

import { parseExpression, type CronExpression } from 'cron-parser';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HeartbeatConfig {
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
}

/** Callback when a heartbeat fires. */
export type HeartbeatCallback = (name: string, prompt: string) => Promise<void>;

interface ScheduledHeartbeat {
  config: HeartbeatConfig;
  timer: ReturnType<typeof setTimeout> | null;
  nextRun: Date | null;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export class HeartbeatScheduler {
  private heartbeats: Map<string, ScheduledHeartbeat> = new Map();
  private callback: HeartbeatCallback;
  private running = false;

  constructor(callback: HeartbeatCallback) {
    this.callback = callback;
  }

  /**
   * Load heartbeat configurations and start scheduling.
   */
  start(configs: HeartbeatConfig[]): void {
    this.running = true;

    for (const config of configs) {
      this.heartbeats.set(config.name, {
        config,
        timer: null,
        nextRun: null,
      });

      if (config.enabled) {
        this.scheduleNext(config.name);
      }

      console.log(
        `[scheduler] Loaded heartbeat "${config.name}" ` +
        `(${config.schedule}, ${config.enabled ? 'enabled' : 'disabled'})`,
      );
    }

    console.log(
      `[scheduler] Started with ${configs.length} heartbeat(s), ` +
      `${configs.filter((c) => c.enabled).length} enabled`,
    );
  }

  /**
   * Stop all scheduled heartbeats.
   */
  stop(): void {
    this.running = false;
    for (const [, scheduled] of this.heartbeats) {
      if (scheduled.timer) {
        clearTimeout(scheduled.timer);
        scheduled.timer = null;
      }
    }
    console.log('[scheduler] Stopped');
  }

  /**
   * Enable or disable a heartbeat by name.
   * Returns true if the heartbeat was found and toggled.
   */
  toggle(name: string, enabled: boolean): boolean {
    const scheduled = this.heartbeats.get(name);
    if (!scheduled) return false;

    scheduled.config.enabled = enabled;

    if (enabled) {
      this.scheduleNext(name);
      console.log(`[scheduler] Enabled heartbeat "${name}"`);
    } else {
      if (scheduled.timer) {
        clearTimeout(scheduled.timer);
        scheduled.timer = null;
        scheduled.nextRun = null;
      }
      console.log(`[scheduler] Disabled heartbeat "${name}"`);
    }

    return true;
  }

  /**
   * Get the list of all heartbeats and their status.
   */
  list(): Array<{
    name: string;
    schedule: string;
    prompt: string;
    enabled: boolean;
    nextRun: string | null;
  }> {
    const result: Array<{
      name: string;
      schedule: string;
      prompt: string;
      enabled: boolean;
      nextRun: string | null;
    }> = [];

    for (const [, scheduled] of this.heartbeats) {
      result.push({
        name: scheduled.config.name,
        schedule: scheduled.config.schedule,
        prompt: scheduled.config.prompt,
        enabled: scheduled.config.enabled,
        nextRun: scheduled.nextRun?.toISOString() ?? null,
      });
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Scheduling Logic
  // -------------------------------------------------------------------------

  /**
   * Schedule the next run of a heartbeat.
   */
  private scheduleNext(name: string): void {
    const scheduled = this.heartbeats.get(name);
    if (!scheduled || !scheduled.config.enabled || !this.running) return;

    // Cancel any existing timer
    if (scheduled.timer) {
      clearTimeout(scheduled.timer);
    }

    try {
      // Parse the cron expression and get the next occurrence
      const cron: CronExpression = parseExpression(scheduled.config.schedule, {
        currentDate: new Date(),
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });

      const next = cron.next().toDate();
      scheduled.nextRun = next;

      const delayMs = next.getTime() - Date.now();

      if (delayMs <= 0) {
        // Somehow in the past — schedule for the next occurrence
        const nextNext = cron.next().toDate();
        scheduled.nextRun = nextNext;
        const nextDelay = nextNext.getTime() - Date.now();
        this.setTimer(name, nextDelay);
      } else {
        this.setTimer(name, delayMs);
      }

      console.log(
        `[scheduler] "${name}" next run: ${scheduled.nextRun.toISOString()} ` +
        `(in ${Math.round(delayMs / 1000 / 60)} minutes)`,
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(
        `[scheduler] Failed to parse cron schedule for "${name}": ${error.message}`,
      );
    }
  }

  /**
   * Set a timer for a heartbeat.
   * Handles the 32-bit setTimeout limit (~24.8 days) by chaining.
   */
  private setTimer(name: string, delayMs: number): void {
    const scheduled = this.heartbeats.get(name);
    if (!scheduled) return;

    // setTimeout max safe value is 2^31 - 1 (~24.8 days)
    const MAX_TIMEOUT = 2147483647;

    if (delayMs > MAX_TIMEOUT) {
      // Chain: wait MAX_TIMEOUT, then re-schedule
      scheduled.timer = setTimeout(() => {
        this.setTimer(name, delayMs - MAX_TIMEOUT);
      }, MAX_TIMEOUT);

      if (scheduled.timer.unref) {
        scheduled.timer.unref();
      }
      return;
    }

    scheduled.timer = setTimeout(async () => {
      await this.fire(name);
    }, delayMs);

    // Allow the process to exit even if the timer is pending
    if (scheduled.timer.unref) {
      scheduled.timer.unref();
    }
  }

  /**
   * Fire a heartbeat: execute the callback and schedule the next run.
   */
  private async fire(name: string): Promise<void> {
    const scheduled = this.heartbeats.get(name);
    if (!scheduled || !scheduled.config.enabled || !this.running) return;

    console.log(`[scheduler] Firing heartbeat "${name}"`);

    try {
      await this.callback(name, scheduled.config.prompt);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(
        `[scheduler] Error executing heartbeat "${name}":`,
        error.message,
      );
    }

    // Schedule the next run
    this.scheduleNext(name);
  }
}
