/**
 * Every deep link `functions/src/catalogue.ts` can emit must land somewhere
 * real. The table below is copied from that file's five link shapes.
 */
import { ROUTES, orderRoute, proposalRoute, routeForDeepLink, routeForPushData } from './deeplink';

describe('catalogue deep links', () => {
  it.each([
    ['pm://proposals/p1', '/proposals/p1'],
    ['pm://orders/o1', '/orders/o1'],
    ['pm://broker-connect', '/broker'],
    ['pm://audit', '/audit'],
    ['pm://dashboard', '/'],
  ])('%s routes to %s', (link, expected) => {
    expect(routeForDeepLink(link)).toBe(expected);
  });

  it('accepts the bare-path form Linking hands back to a running app', () => {
    expect(routeForDeepLink('/proposals/p1')).toBe('/proposals/p1');
    expect(routeForDeepLink('proposals')).toBe(ROUTES.proposals);
  });

  it('routes settings and its child', () => {
    expect(routeForDeepLink('pm://settings')).toBe(ROUTES.settings);
    expect(routeForDeepLink('pm://settings/guardrails')).toBe(ROUTES.guardrails);
  });

  it('ignores an unknown head rather than navigating somewhere arbitrary', () => {
    expect(routeForDeepLink('pm://nope')).toBeUndefined();
    expect(routeForDeepLink(undefined)).toBeUndefined();
    expect(routeForDeepLink('')).toBeUndefined();
  });

  it('refuses an id that is not a plain document id', () => {
    expect(routeForDeepLink('pm://proposals/../../etc')).toBeUndefined();
    expect(routeForDeepLink('pm://orders/a b')).toBeUndefined();
  });

  it('strips a query string before matching', () => {
    expect(routeForDeepLink('pm://proposals/p1?utm=push')).toBe('/proposals/p1');
  });

  it('encodes ids it does accept', () => {
    expect(proposalRoute('p-1')).toBe('/proposals/p-1');
    expect(orderRoute('o_1')).toBe('/orders/o_1');
  });
});

describe('push payload routing', () => {
  // The exact `data` payloads from functions/src/catalogue.ts.
  it.each([
    [{ type: 'proposal', proposalId: 'p1', deepLink: 'pm://proposals/p1' }, '/proposals/p1'],
    [{ type: 'order', orderId: 'o1', deepLink: 'pm://orders/o1' }, '/orders/o1'],
    [{ type: 'session', deepLink: 'pm://broker-connect' }, '/broker'],
    [{ type: 'audit', deepLink: 'pm://audit' }, '/audit'],
    [{ type: 'killswitch', deepLink: 'pm://dashboard' }, '/'],
  ])('%j routes correctly', (data, expected) => {
    expect(routeForPushData(data)).toBe(expected);
  });

  it('falls back to type + id when deepLink is missing', () => {
    expect(routeForPushData({ type: 'proposal', proposalId: 'p9' })).toBe('/proposals/p9');
    expect(routeForPushData({ type: 'order', orderId: 'o9' })).toBe('/orders/o9');
    expect(routeForPushData({ type: 'session' })).toBe('/broker');
    expect(routeForPushData({ type: 'audit' })).toBe('/audit');
    expect(routeForPushData({ type: 'killswitch' })).toBe('/');
  });

  it('falls back to the list when the id is unusable', () => {
    expect(routeForPushData({ type: 'proposal' })).toBe(ROUTES.proposals);
    expect(routeForPushData({ type: 'order', orderId: '../x' })).toBe(ROUTES.orders);
  });

  it('ignores an unknown or absent payload', () => {
    expect(routeForPushData({ type: 'mystery' })).toBeUndefined();
    expect(routeForPushData(undefined)).toBeUndefined();
  });
});
