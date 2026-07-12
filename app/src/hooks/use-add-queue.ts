import { useCallback, useRef, useState } from "react";

/** Serial FIFO for add-record submissions. Every enqueued label is attempted
 *  in order; a failure surfaces through onError (with the lost label) instead
 *  of being dropped, and never blocks the labels behind it. `pending` drives
 *  the submit button's spinner. */
export function useAddQueue(
  run: (label: string) => Promise<void>,
  onError: (label: string, err: unknown) => void,
): { enqueue: (label: string) => void; pending: number } {
  const [pending, setPending] = useState(0);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const runRef = useRef(run);
  runRef.current = run;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const enqueue = useCallback((label: string) => {
    setPending((n) => n + 1);
    chain.current = chain.current.then(async () => {
      try {
        await runRef.current(label);
      } catch (err) {
        onErrorRef.current(label, err);
      } finally {
        setPending((n) => n - 1);
      }
    });
  }, []);

  return { enqueue, pending };
}
