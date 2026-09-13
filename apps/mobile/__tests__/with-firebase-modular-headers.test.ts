import { MARKER, patchPodfile } from '../plugins/with-firebase-modular-headers';

// Trimmed from the Podfile Expo SDK 57 actually generates.
const PODFILE = [
  "platform :ios, podfile_properties['ios.deploymentTarget'] || '16.4'",
  '',
  'prepare_react_native_project!',
  '',
  "target 'PortfolioManager' do",
  '  use_expo_modules!',
  '',
  '  config = use_native_modules!(config_command)',
  'end',
  '',
].join('\n');

describe('with-firebase-modular-headers', () => {
  it('inserts the three modular_headers pods directly after use_expo_modules!, indented', () => {
    const lines = patchPodfile(PODFILE).split('\n');
    const at = lines.indexOf('  use_expo_modules!');
    expect(at).toBeGreaterThan(-1);
    expect(lines[at + 1]).toBe(`  ${MARKER}`);
    expect(lines[at + 2]).toBe("  pod 'GoogleUtilities', :modular_headers => true");
    expect(lines[at + 3]).toBe("  pod 'FirebaseCore', :modular_headers => true");
    expect(lines[at + 4]).toBe("  pod 'FirebaseCoreInternal', :modular_headers => true");
    // The rest of the file is untouched.
    expect(lines[at + 5]).toBe('');
    expect(lines[at + 6]).toBe('  config = use_native_modules!(config_command)');
  });

  it('is idempotent across repeated prebuilds', () => {
    const once = patchPodfile(PODFILE);
    expect(patchPodfile(once)).toBe(once);
  });

  it('fails loudly if the Expo template loses the anchor', () => {
    expect(() => patchPodfile("target 'X' do\nend\n")).toThrow(/use_expo_modules!/);
  });
});
