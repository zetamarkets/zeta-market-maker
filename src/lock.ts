import { Mutex } from "async-mutex";
import { log } from "./log";
import { sleep } from "./utils";

export class LockedRunner {
  private waitPeriod: number;
  private locks: Map<string, Mutex>;
  private lastRuns: Map<string, number>;
  private lockIds: string[];

  constructor(waitPeriod: number, lockIds: string[]) {
    this.waitPeriod = waitPeriod;
    this.lockIds = lockIds;
    this.locks = new Map(
      lockIds.map((x): [string, Mutex] => {
        return [x, new Mutex()];
      })
    );
    this.lastRuns = new Map(
      lockIds.map((x): [string, number] => {
        return [x, 0];
      })
    );
  }

  async runExclusive<T>(
    lockId: string,
    onDelay: "reject" | "wait" | "proceed",
    run: () => Promise<T>
  ): Promise<[T, boolean]> {
    if (!this.lockIds.includes(lockId))
      throw new Error(`Unrecognized lockId ${lockId}`);

    const that = this;
    async function decoratedRun(): Promise<[T, boolean]> {
      const lastRunTs = that.lastRuns.get(lockId);
      const delayTs = lastRunTs + that.waitPeriod - Date.now();
      if (delayTs > 0)
        switch (onDelay) {
          case "wait":
            log.debug(
              `Waiting ${delayTs}ms for lock ${lockId} (lastRunTs ${lastRunTs})`
            );
            await sleep(delayTs);
            log.debug(
              `Done with the wait for ${delayTs}ms for lock ${lockId} (lastRunTs ${lastRunTs})`
            );
            break;
          case "reject":
            log.debug(
              `Rejecting operation under lock ${lockId}, unlock period is ${delayTs}ms in the future (lastRunTs ${lastRunTs})`
            );
            return [undefined, false];
          case "proceed":
            log.debug(
              `Proceeding on operation under lock ${lockId} despite delay ${delayTs}ms (lastRunTs ${lastRunTs})`
            );
            break;
        }
      else
        log.debug(
          `No delay on lock ${lockId}, executing (lastRunTs ${lastRunTs})`
        );

      const res = await run();
      const finishTs = Date.now();
      log.debug(
        `Finished execution on lock ${lockId} @ (lastRunTs ${lastRunTs}, finishTs ${finishTs})`
      );
      that.lastRuns.set(lockId, finishTs);
      return [res, true];
    }
    const lock = this.locks.get(lockId);
    if (onDelay == "reject" && lock.isLocked()) {
      // premature rejection, not even entering the mutex lock
      log.debug(
        `Rejecting operation under lock ${lockId}, not attempting the mutex await`
      );
      return [undefined, false];
    }
    return await lock.runExclusive(decoratedRun);
  }
}
