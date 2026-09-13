// Expo config plugin: apply the RNFB "LIGHT stack" Podfile recipe automatically.
//
// React Native Firebase (messaging only — auth/firestore are the JS SDK here)
// fails at `pod install` with
//   "Swift pod `FirebaseCoreInternal` depends upon `GoogleUtilities`, which does
//    not define modules…"
// unless these three pods opt in to modular headers. The house rule
// (~/.claude/RNFB.md, mirrored in README §3) is to add them right after
// `use_expo_modules!`. With Continuous Native Generation `ios/` is regenerated
// by every prebuild, so hand-editing the Podfile does not survive — this plugin
// does the edit on every prebuild instead, and is idempotent.
//
// CommonJS on purpose: Expo loads local config plugins with `require`.
const fs = require('node:fs');
const path = require('node:path');
const { withDangerousMod } = require('expo/config-plugins');

const MARKER = '# @pm/mobile: RNFB LIGHT-stack modular headers (with-firebase-modular-headers.js)';
const PODS = ['GoogleUtilities', 'FirebaseCore', 'FirebaseCoreInternal'];

/**
 * Pure: returns the Podfile contents with the three `:modular_headers => true`
 * pods inserted directly after `use_expo_modules!`, preserving indentation.
 * Idempotent (keyed on MARKER). Throws if the anchor is missing so a changed
 * Expo template fails loudly instead of silently producing an unbuildable app.
 * @param {string} contents
 * @returns {string}
 */
function patchPodfile(contents) {
  if (contents.includes(MARKER)) return contents;
  const anchor = /^([ \t]*)use_expo_modules!\s*$/m;
  const match = anchor.exec(contents);
  if (match === null) {
    throw new Error(
      'with-firebase-modular-headers: `use_expo_modules!` not found in ios/Podfile — ' +
        'the Expo Podfile template changed; update the anchor in plugins/with-firebase-modular-headers.js',
    );
  }
  const indent = match[1];
  const block = [MARKER, ...PODS.map((pod) => `pod '${pod}', :modular_headers => true`)]
    .map((line) => `${indent}${line}`)
    .join('\n');
  const insertAt = match.index + match[0].length;
  return `${contents.slice(0, insertAt)}\n${block}${contents.slice(insertAt)}`;
}

/** @type {import('expo/config-plugins').ConfigPlugin} */
const withFirebaseModularHeaders = (config) =>
  withDangerousMod(config, [
    'ios',
    (cfg) => {
      const podfile = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      fs.writeFileSync(podfile, patchPodfile(fs.readFileSync(podfile, 'utf8')));
      return cfg;
    },
  ]);

module.exports = withFirebaseModularHeaders;
module.exports.patchPodfile = patchPodfile;
module.exports.MARKER = MARKER;
