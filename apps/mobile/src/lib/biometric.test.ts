import * as LocalAuthentication from 'expo-local-authentication';
import { biometricAvailable, biometricRefusalMessage, runBiometricGate } from './biometric';

const mocked = LocalAuthentication as jest.Mocked<typeof LocalAuthentication>;

function reset(overrides: {
  hasHardware?: boolean;
  enrolled?: boolean;
  result?: { success: boolean; error?: string };
}) {
  mocked.hasHardwareAsync.mockResolvedValue(overrides.hasHardware ?? true);
  mocked.isEnrolledAsync.mockResolvedValue(overrides.enrolled ?? true);
  mocked.authenticateAsync.mockResolvedValue((overrides.result ?? { success: true }) as never);
}

const OPTIONS = { required: true, promptMessage: 'Confirm' };

describe('runBiometricGate', () => {
  beforeEach(() => reset({}));

  it('passes when the prompt succeeds', async () => {
    await expect(runBiometricGate(OPTIONS)).resolves.toEqual({ ok: true, method: 'device' });
    expect(mocked.authenticateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ promptMessage: 'Confirm', disableDeviceFallback: false }),
    );
  });

  it('skips the prompt entirely when the config does not require it', async () => {
    await expect(runBiometricGate({ ...OPTIONS, required: false })).resolves.toEqual({
      ok: true,
      method: 'not-required',
    });
    expect(mocked.authenticateAsync).not.toHaveBeenCalled();
  });

  // docs/00 §0.7.1 — missing evidence is a refusal, never a skip.
  it('fails closed when the device has no sensor', async () => {
    reset({ hasHardware: false });
    const outcome = await runBiometricGate(OPTIONS);
    expect(outcome).toEqual({
      ok: false,
      reason: 'NO_HARDWARE',
      detail: biometricRefusalMessage('NO_HARDWARE'),
    });
    expect(mocked.authenticateAsync).not.toHaveBeenCalled();
  });

  it('fails closed when nothing is enrolled', async () => {
    reset({ enrolled: false });
    const outcome = await runBiometricGate(OPTIONS);
    expect(outcome).toMatchObject({ ok: false, reason: 'NOT_ENROLLED' });
    expect(mocked.authenticateAsync).not.toHaveBeenCalled();
  });

  it('distinguishes a cancel from a failure', async () => {
    reset({ result: { success: false, error: 'user_cancel' } });
    await expect(runBiometricGate(OPTIONS)).resolves.toMatchObject({ reason: 'CANCELLED' });

    reset({ result: { success: false, error: 'authentication_failed' } });
    await expect(runBiometricGate(OPTIONS)).resolves.toMatchObject({ reason: 'FAILED' });
  });

  it('treats a capability probe that throws as unavailable, not as a pass', async () => {
    mocked.hasHardwareAsync.mockRejectedValue(new Error('native module missing'));
    await expect(runBiometricGate(OPTIONS)).resolves.toMatchObject({
      ok: false,
      reason: 'UNAVAILABLE',
    });
  });

  it('treats a prompt that throws as unavailable', async () => {
    reset({});
    mocked.authenticateAsync.mockRejectedValue(new Error('boom'));
    await expect(runBiometricGate(OPTIONS)).resolves.toMatchObject({
      ok: false,
      reason: 'UNAVAILABLE',
    });
  });
});

describe('biometricAvailable', () => {
  it('is true only with hardware and an enrolment', async () => {
    reset({});
    await expect(biometricAvailable()).resolves.toBe(true);

    reset({ enrolled: false });
    await expect(biometricAvailable()).resolves.toBe(false);

    mocked.hasHardwareAsync.mockRejectedValue(new Error('nope'));
    await expect(biometricAvailable()).resolves.toBe(false);
  });
});
