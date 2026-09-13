/**
 * The live TTL countdown (docs/06 §6.3 (2)/(3)).
 *
 * Ticks once a second and stops at zero — an expired proposal must not keep a
 * timer alive behind a read-only screen. The instant is only read inside the
 * effect, so the pure `secondsUntil` in `lib/proposals.ts` stays clock-free and
 * testable (docs/00 §0.5).
 */
import { useEffect, useState } from 'react';
import { secondsUntil } from '../lib/proposals';

export interface Countdown {
  secondsRemaining: number;
  expired: boolean;
}

export function useCountdown(ttlExpiresAt: string | undefined, tickMs = 1000): Countdown {
  const [seconds, setSeconds] = useState(() =>
    ttlExpiresAt === undefined ? 0 : secondsUntil(ttlExpiresAt, new Date()),
  );

  useEffect(() => {
    if (ttlExpiresAt === undefined) {
      setSeconds(0);
      return;
    }
    setSeconds(secondsUntil(ttlExpiresAt, new Date()));
    const id = setInterval(() => {
      const next = secondsUntil(ttlExpiresAt, new Date());
      setSeconds(next);
      if (next <= 0) clearInterval(id);
    }, tickMs);
    return () => clearInterval(id);
  }, [ttlExpiresAt, tickMs]);

  return {
    secondsRemaining: seconds,
    expired: ttlExpiresAt !== undefined && seconds <= 0,
  };
}
