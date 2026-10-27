import type { WorkerActivity, WorkerEntryEvaluation } from "../workers/entryEvaluation";

/** Page-only diagnostics. Query AFTER lazy code ran, so a second entry evaluation cannot hide. */
export class WorkerProfiles {
  private readonly workers: Worker[] = [];
  readonly activity: (WorkerActivity & { worker: string })[] = [];
  track(worker: Worker): Worker { this.workers.push(worker); return worker; }

  async snapshot(): Promise<WorkerEntryEvaluation[]> {
    return Promise.all(this.workers.map((worker, index) => new Promise<WorkerEntryEvaluation>((resolve, reject) => {
      const requestId = index + 1;
      const clean = () => {
        clearTimeout(timer);
        worker.removeEventListener("message", receive);
        worker.removeEventListener("error", failed);
      };
      const failed = (event: ErrorEvent) => { clean(); reject(new Error(`Worker profile failed: ${event.message}`)); };
      const receive = (event: MessageEvent) => {
        if (event.data?.kind !== "chemdraft-worker-profile" || event.data.requestId !== requestId) return;
        clean();
        const entries = event.data.entries as WorkerEntryEvaluation[];
        if (entries?.length !== 1) { reject(new Error(`Worker ${requestId} reported ${entries?.length ?? 0} entries; expected one.`)); return; }
        for (const record of (event.data.activity ?? []) as WorkerActivity[]) {
          this.activity.push({ ...record, worker: entries[0].worker });
        }
        resolve(entries[0]);
      };
      const timer = setTimeout(() => { clean(); reject(new Error(`Worker ${requestId} did not report entry evaluations within 5 seconds.`)); }, 5000);
      worker.addEventListener("message", receive);
      worker.addEventListener("error", failed);
      try { worker.postMessage({ kind: "chemdraft-worker-profile-request", requestId }); }
      catch (error) { clean(); reject(error); }
    })));
  }

  dispose(): void { for (const worker of this.workers) worker.terminate(); }
}

/** Wait for a real protocol reply, without replacing the transport's existing handlers. */
export function workerReply<T>(worker: Worker, send: unknown, accept: (message: T) => boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    const clean = () => {
      clearTimeout(timer);
      worker.removeEventListener("message", receive);
      worker.removeEventListener("error", failed);
    };
    const failed = (event: ErrorEvent) => { clean(); reject(new Error(event.message)); };
    const receive = (event: MessageEvent<T>) => {
      if (accept(event.data)) { clean(); resolve(event.data); }
    };
    const timer = setTimeout(() => { clean(); reject(new Error("Profile worker reply timed out after 15 seconds.")); }, 15000);
    worker.addEventListener("message", receive);
    worker.addEventListener("error", failed);
    try { worker.postMessage(send); } catch (error) { clean(); reject(error); }
  });
}
