/**
 * The biometric gate in front of every execute (docs/06 §6.7).
 *
 * Fails closed, per docs/00 §0.7.1: when `config.guardrails.requireBiometric` is
 * on and the device has no sensor, no enrolment, or the prompt does not
 * succeed, the answer is a refusal — never a silent pass. "Unknown" is never
 * "fine" when the next step places a real order.
 */
import * as LocalAuthentication from 'expo-local-authentication';

export type BiometricRefusal =
  'NO_HARDWARE' | 'NOT_ENROLLED' | 'CANCELLED' | 'FAILED' | 'UNAVAILABLE';

export type BiometricOutcome =
  | { ok: true; method: 'device' | 'not-required' }
  | { ok: false; reason: BiometricRefusal; detail: string };

const REFUSAL_COPY: Record<BiometricRefusal, string> = {
  NO_HARDWARE: 'this device has no biometric sensor, and approvals require one',
  NOT_ENROLLED: 'no Face ID / Touch ID / device passcode is enrolled on this device',
  CANCELLED: 'you cancelled the biometric prompt — nothing was sent',
  FAILED: 'biometric check failed — nothing was sent',
  UNAVAILABLE: 'the biometric prompt could not run — nothing was sent',
};

export function biometricRefusalMessage(reason: BiometricRefusal): string {
  return REFUSAL_COPY[reason];
}

/** True when the device could satisfy a biometric gate right now. */
export async function biometricAvailable(): Promise<boolean> {
  try {
    const [hasHardware, enrolled] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);
    return hasHardware && enrolled;
  } catch {
    return false;
  }
}

export interface BiometricGateOptions {
  /** `config.guardrails.requireBiometric`. */
  required: boolean;
  promptMessage: string;
}

/**
 * Runs the gate. When `required` is false this resolves `not-required` without
 * prompting — the config knob is the only thing that can skip it, and the
 * backend is told nothing was asserted.
 */
export async function runBiometricGate(options: BiometricGateOptions): Promise<BiometricOutcome> {
  if (!options.required) return { ok: true, method: 'not-required' };

  let hasHardware: boolean;
  let enrolled: boolean;
  try {
    [hasHardware, enrolled] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);
  } catch {
    return { ok: false, reason: 'UNAVAILABLE', detail: REFUSAL_COPY.UNAVAILABLE };
  }
  if (!hasHardware) {
    return { ok: false, reason: 'NO_HARDWARE', detail: REFUSAL_COPY.NO_HARDWARE };
  }
  if (!enrolled) {
    return { ok: false, reason: 'NOT_ENROLLED', detail: REFUSAL_COPY.NOT_ENROLLED };
  }

  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: options.promptMessage,
      cancelLabel: 'Cancel',
      // Device passcode is an acceptable fallback: it is still "the human with
      // the phone", which is what this gate is asserting.
      disableDeviceFallback: false,
    });
    if (result.success) return { ok: true, method: 'device' };
    const cancelled =
      'error' in result && typeof result.error === 'string' && /cancel/i.test(result.error);
    return cancelled
      ? { ok: false, reason: 'CANCELLED', detail: REFUSAL_COPY.CANCELLED }
      : { ok: false, reason: 'FAILED', detail: REFUSAL_COPY.FAILED };
  } catch {
    return { ok: false, reason: 'UNAVAILABLE', detail: REFUSAL_COPY.UNAVAILABLE };
  }
}
