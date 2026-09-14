/**
 * FCM deep links → Expo Router paths.
 *
 * The catalogue (functions/src/catalogue.ts) emits exactly five link shapes:
 *   pm://proposals/<id>   pm://orders/<id>   pm://broker-connect
 *   pm://audit            pm://dashboard
 *
 * Pure and total: an unknown link returns `undefined` so the caller can ignore
 * it rather than navigating somewhere arbitrary. Push payloads are untrusted
 * input — nothing here interpolates a value into anything but a route segment.
 */

export const ROUTES = {
  dashboard: '/',
  proposals: '/proposals',
  orders: '/orders',
  broker: '/broker',
  audit: '/audit',
  settings: '/settings',
  guardrails: '/settings/guardrails',
  login: '/login',
} as const;

/** An id must be a plain Firestore-ish id — never a path or a scheme. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function proposalRoute(id: string): string {
  return `${ROUTES.proposals}/${encodeURIComponent(id)}`;
}

export function orderRoute(id: string): string {
  return `${ROUTES.orders}/${encodeURIComponent(id)}`;
}

/**
 * `pm://proposals/abc` → `/proposals/abc`.
 * Accepts the `pm://` form the catalogue emits and the bare-path form Expo
 * Linking hands back for an already-running app.
 */
export function routeForDeepLink(link: string | undefined): string | undefined {
  if (link === undefined || link === '') return undefined;

  const withoutScheme = link.replace(/^pm:\/\//i, '').replace(/^\/+/, '');
  const [head, ...rest] = withoutScheme.split('?')[0]?.split('/') ?? [];
  const id = rest[0];

  switch (head) {
    case '':
    case 'dashboard':
      return ROUTES.dashboard;
    case 'proposals':
      if (id === undefined) return ROUTES.proposals;
      return SAFE_ID.test(id) ? proposalRoute(id) : undefined;
    case 'orders':
      if (id === undefined) return ROUTES.orders;
      return SAFE_ID.test(id) ? orderRoute(id) : undefined;
    case 'broker-connect':
    case 'broker':
      return ROUTES.broker;
    case 'audit':
      return ROUTES.audit;
    case 'settings':
      return id === 'guardrails' ? ROUTES.guardrails : ROUTES.settings;
    default:
      return undefined;
  }
}

/**
 * The FCM `data` payload → a route. Prefers the explicit `deepLink` the
 * catalogue always sets, falling back to `type` + id for a payload written by
 * an older function revision.
 */
export function routeForPushData(
  data: Record<string, string | undefined> | undefined,
): string | undefined {
  if (data === undefined) return undefined;

  const fromLink = routeForDeepLink(data['deepLink']);
  if (fromLink !== undefined) return fromLink;

  switch (data['type']) {
    case 'proposal': {
      const id = data['proposalId'];
      return id !== undefined && SAFE_ID.test(id) ? proposalRoute(id) : ROUTES.proposals;
    }
    case 'order': {
      const id = data['orderId'];
      return id !== undefined && SAFE_ID.test(id) ? orderRoute(id) : ROUTES.orders;
    }
    case 'session':
      return ROUTES.broker;
    case 'audit':
      return ROUTES.audit;
    case 'killswitch':
      return ROUTES.dashboard;
    default:
      return undefined;
  }
}
