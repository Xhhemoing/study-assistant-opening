/**
 * One request per explicit attempt. React StrictMode runs mount → cleanup →
 * mount with the same state; the second run must join the first request
 * instead of POSTing again. A user-initiated retry bumps the key.
 */
export function createSingleFlight<T>() {
  let current: { key: number; promise: Promise<T> } | null = null;
  return {
    run(key: number, start: () => Promise<T>): Promise<T> {
      if (current?.key !== key) current = { key, promise: start() };
      return current.promise;
    },
  };
}
