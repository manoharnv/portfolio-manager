/**
 * The Firebase auth session — the root gate for every other hook and for the
 * router's auth guard (`app/_layout.tsx`).
 */
import { useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
import { watchAuth } from '../lib/firebase';
import { MissingConfigError } from '../lib/env';

export interface Session {
  user: User | null;
  uid: string | undefined;
  /** false until Firebase has restored (or failed to restore) persisted auth. */
  ready: boolean;
  /** Set when the build has no Firebase config at all. */
  configError: string | undefined;
}

export function useSession(): Session {
  const [state, setState] = useState<Session>({
    user: null,
    uid: undefined,
    ready: false,
    configError: undefined,
  });

  useEffect(() => {
    try {
      return watchAuth((user) => {
        setState({
          user,
          uid: user?.uid ?? undefined,
          ready: true,
          configError: undefined,
        });
      });
    } catch (error) {
      setState({
        user: null,
        uid: undefined,
        ready: true,
        configError:
          error instanceof MissingConfigError
            ? error.message
            : 'Firebase could not start — check the app configuration.',
      });
      return undefined;
    }
  }, []);

  return state;
}
