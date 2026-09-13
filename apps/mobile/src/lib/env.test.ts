/**
 * `env.ts` fails closed (docs/00 §0.7.1): a missing backend URL or Firebase key
 * is an error at the point of use, never a default that would send an ID token
 * somewhere unintended.
 */
import Constants from 'expo-constants';
import {
  MissingConfigError,
  backendBaseUrl,
  brokerLoginUrlTemplate,
  brokerRedirectUrl,
  extra,
  firebaseConfig,
  googleClientIds,
} from './env';

const constants = Constants as unknown as { expoConfig: { extra: Record<string, unknown> } | null };
const ORIGINAL = constants.expoConfig;

afterEach(() => {
  constants.expoConfig = ORIGINAL;
});

function setExtra(value: Record<string, unknown> | undefined) {
  constants.expoConfig = value === undefined ? null : { extra: value };
}

describe('backendBaseUrl', () => {
  it('strips a trailing slash', () => {
    setExtra({ backendBaseUrl: 'https://api.example.com/' });
    expect(backendBaseUrl()).toBe('https://api.example.com');
  });

  it('throws a named error when it is missing or blank', () => {
    setExtra({});
    expect(() => backendBaseUrl()).toThrow(MissingConfigError);
    setExtra({ backendBaseUrl: '' });
    expect(() => backendBaseUrl()).toThrow(/backendBaseUrl/);
  });
});

describe('firebaseConfig', () => {
  it('returns the whole web config when it is complete', () => {
    expect(firebaseConfig().projectId).toBe('test-project');
  });

  it('names the first missing key', () => {
    setExtra({ firebase: { apiKey: 'k' } });
    expect(() => firebaseConfig()).toThrow(/firebase.authDomain/);
  });

  it('throws when there is no firebase block at all', () => {
    setExtra({});
    expect(() => firebaseConfig()).toThrow(/firebase.apiKey/);
  });
});

describe('the optional values', () => {
  it('omits absent Google client ids rather than defaulting them', () => {
    setExtra({ google: { webClientId: 'w' } });
    expect(googleClientIds()).toEqual({ webClientId: 'w' });

    setExtra({});
    expect(googleClientIds()).toEqual({});
  });

  it('defaults the broker redirect to the app scheme', () => {
    setExtra({});
    expect(brokerRedirectUrl()).toBe('pm://broker-callback');
    setExtra({ brokerRedirectUrl: 'https://example.com/cb' });
    expect(brokerRedirectUrl()).toBe('https://example.com/cb');
  });

  it('treats a blank broker login template as absent', () => {
    setExtra({ brokerLoginUrlTemplates: { kite: '', dhan: 'https://d/login' } });
    expect(brokerLoginUrlTemplate('kite')).toBeUndefined();
    expect(brokerLoginUrlTemplate('dhan')).toBe('https://d/login');

    setExtra({});
    expect(brokerLoginUrlTemplate('kite')).toBeUndefined();
  });

  it('survives a config with no expoConfig at all', () => {
    setExtra(undefined);
    expect(extra()).toEqual({});
  });
});
