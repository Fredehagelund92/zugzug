import { useCallback, useEffect, useRef, useState } from "react";

/** Shared duration for ephemeral success/error notices across the app.
 *  Chosen as the median of the previous ad-hoc 2.6/2.8/3.2s values. */
export const FLASH_DURATION_MS = 2800;

export type FlashVariant = "success" | "error";

export interface Flash {
  message: string | null;
  variant: FlashVariant;
  show: (msg: string, variant?: FlashVariant) => void;
}

/** Ephemeral success/error notice for a single screen. Auto-clears after
 *  FLASH_DURATION_MS. A second show() replaces the first and resets the timer. */
export function useFlash(): Flash {
  const [message, setMessage] = useState<string | null>(null);
  const [variant, setVariant] = useState<FlashVariant>("success");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((msg: string, v: FlashVariant = "success") => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setMessage(msg);
    setVariant(v);
    timerRef.current = setTimeout(() => setMessage(null), FLASH_DURATION_MS);
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return { message, variant, show };
}
