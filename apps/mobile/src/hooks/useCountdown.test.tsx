import { act, renderHook } from '@testing-library/react-native';
import { useCountdown } from './useCountdown';
import { NOW, isoPlus } from '../test-utils';

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});
afterEach(() => jest.useRealTimers());

describe('useCountdown', () => {
  it('starts at the remaining seconds and ticks down', async () => {
    const { result } = await renderHook(() => useCountdown(isoPlus(10)));
    expect(result.current.secondsRemaining).toBe(10);
    expect(result.current.expired).toBe(false);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(3000);
    });
    expect(result.current.secondsRemaining).toBe(7);
  });

  it('stops at zero and reports expired', async () => {
    const { result } = await renderHook(() => useCountdown(isoPlus(2)));

    await act(async () => {
      await jest.advanceTimersByTimeAsync(5000);
    });
    expect(result.current.secondsRemaining).toBe(0);
    expect(result.current.expired).toBe(true);

    // The interval cleared itself; more time changes nothing.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });
    expect(result.current.secondsRemaining).toBe(0);
  });

  it('starts already expired for a past instant', async () => {
    const { result } = await renderHook(() => useCountdown(isoPlus(-30)));
    expect(result.current).toEqual({ secondsRemaining: 0, expired: true });
  });

  it('is inert with no TTL at all', async () => {
    const { result } = await renderHook(() => useCountdown(undefined));
    expect(result.current).toEqual({ secondsRemaining: 0, expired: false });
  });

  it('clears its interval on unmount', async () => {
    const clearSpy = jest.spyOn(globalThis, 'clearInterval');
    const { unmount } = await renderHook(() => useCountdown(isoPlus(60)));
    await unmount();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
