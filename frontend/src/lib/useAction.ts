import { useCallback, useState } from "react";
import { errorText } from "../api";

/** Pending and visible error state for one user-triggered API call. */
export const useAction = () => {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (action: () => Promise<unknown>): Promise<boolean> => {
    setPending(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (cause) {
      setError(errorText(cause));
      return false;
    } finally {
      setPending(false);
    }
  }, []);

  return { pending, error, run };
};
