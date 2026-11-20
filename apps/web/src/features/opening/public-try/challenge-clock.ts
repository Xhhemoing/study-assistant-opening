import { useEffect, useState } from "react";

const duration = 90_000;

export function useChallengeClock() {
  const [remaining, setRemaining] = useState(duration);
  const [deadline, setDeadline] = useState<number | null>(null);

  useEffect(() => {
    if (deadline === null) return;
    const interval = window.setInterval(() => {
      const left = Math.max(0, deadline - Date.now());
      setRemaining(left);
      if (!left) setDeadline(null);
    }, 200);
    return () => window.clearInterval(interval);
  }, [deadline]);

  function stop() {
    const left = deadline === null ? remaining : Math.max(0, deadline - Date.now());
    setRemaining(left);
    setDeadline(null);
    return left;
  }

  return {
    seconds: Math.ceil(remaining / 1000),
    running: deadline !== null,
    start: () => setDeadline(Date.now() + remaining),
    stop,
  };
}
