import { randomUUID } from 'node:crypto';
import type {ModelConfiguration} from './model-contract.ts';

export interface ModelLoadReceipt { [key: string]: unknown; request?: unknown; id?: unknown; ok?: unknown; reason?: unknown }

/** One in-flight body application. Transport is injected; persistence belongs to ModelDomain.
 * A connected page is not evidence of application: only its matching first-frame receipt is.
 */
export function createModelApplication<Skin extends { figure?: string }, Receipt extends ModelLoadReceipt>(ports: {
  send: (message: { t: 'load-figure'; request: string; skin: Skin } | { t: 'cancel-figure-load'; request: string }
    | {t:'configure-model';request:string;id:string;configuration:ModelConfiguration}) => boolean;
  failure: () => string;
  loadFailed?: (figure: string, reason: string) => void;
  timeoutMs?: number;
}) {
  let pending: { request: string; receive: (receipt: Receipt) => void; cancel: () => void } | undefined;
  function dispatch(skin:Skin,signal:AbortSignal,configuration?:ModelConfiguration):Promise<Receipt|undefined> {
      if (signal.aborted) return Promise.reject(signal.reason);
      if (pending) return Promise.reject(new Error('A body application is already pending'));
      const request = randomUUID();
      return new Promise((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const clean = () => {
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', cancel);
          if (pending?.request === request) pending = undefined;
        };
        const fail = (reason?: unknown) => {
          if (settled) return;
          clean();
          // Transport cleanup must not leave the operation unresolved if the socket throws.
          try { if(!configuration)ports.send({ t: 'cancel-figure-load', request }); } catch { /* disconnected */ }
          reject(signal.reason ?? reason ?? new Error(ports.failure()));
        };
        const cancel = () => fail();
        const receive = (receipt: Receipt) => {
          if (settled) return;
          if (receipt.ok === true && receipt.id === skin.figure && (!configuration||receipt.configurationRevision===configuration.revision)) {
            clean(); resolve(receipt);
          } else {
            const reason = typeof receipt.reason === 'string' && receipt.reason ? receipt.reason.slice(0, 240) : ports.failure();
            fail(new Error(reason));
            if (!configuration && skin.figure) ports.loadFailed?.(skin.figure, reason);
          }
        };
        // Register before sending: an in-process adapter may acknowledge synchronously.
        pending = { request, receive, cancel };
        // A configuration update is one synchronous renderer commit. Cancellation
        // before dispatch is safe; afterward reconcile its receipt, not a fictitious rollback.
        if(!configuration)signal.addEventListener('abort', cancel, { once: true });
        timer = setTimeout(cancel, configuration ? Math.min(ports.timeoutMs??10_000,10_000) : ports.timeoutMs ?? 24_000);
        try {
          const message=configuration?{t:'configure-model' as const,request,id:skin.figure!,configuration}:{t:'load-figure' as const,request,skin};
          if (!ports.send(message) && !settled) {
            clean(); resolve(undefined); // saved selection only; no active body accepted it
          }
        } catch (error) { fail(error); }
      });
    }
  return {
    load: (skin:Skin,signal:AbortSignal)=>dispatch(skin,signal),
    configure: (id:string,configuration:ModelConfiguration,signal:AbortSignal)=>dispatch({figure:id} as Skin,signal,configuration),
    receive(receipt: Receipt): void {
      if (pending && receipt.request === pending.request) pending.receive(receipt);
    },
    disconnected(): void { pending?.cancel(); },
  };
}
