/**
 * The handles `jest.setup.js` hangs off `globalThis` so a test can drive the
 * Firestore / Auth / messaging / router doubles. Declared here rather than cast
 * at every use site.
 */
import type { RenderResult } from '@testing-library/react-native';

declare global {
  var __firestoreMock: {
    emitDoc(path: string, data: unknown, options?: { id?: string; fromCache?: boolean }): void;
    emitCollection(
      path: string,
      docs: { id: string; data: unknown }[],
      options?: { fromCache?: boolean },
    ): void;
    emitError(path: string, error: unknown): void;
    listenerCount(path: string): number;
    reset(): void;
    failNextUpdate(error: Error): void;
    readonly updates: { path: string; data: Record<string, unknown> }[];
  };

  var __authMock: {
    setUser(user: unknown): void;
    reset(): void;
  };

  var __messagingMock: {
    getMessaging: jest.Mock;
    requestPermission: jest.Mock;
    getToken: jest.Mock;
    onMessage: jest.Mock;
    onNotificationOpenedApp: jest.Mock;
    getInitialNotification: jest.Mock;
    setBackgroundMessageHandler: jest.Mock;
    AuthorizationStatus: Record<string, number>;
  };

  var __routerMock: {
    push: jest.Mock;
    replace: jest.Mock;
    back: jest.Mock;
    canGoBack: jest.Mock;
  };

  /** Whatever `useLocalSearchParams()` should return in the next render. */
  var __routeParams: { current: Record<string, string | string[] | undefined> };
}

export type { RenderResult };
