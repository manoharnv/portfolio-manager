import type { ConfigPlugin } from 'expo/config-plugins';

declare const withFirebaseModularHeaders: ConfigPlugin & {
  patchPodfile: (contents: string) => string;
  MARKER: string;
};

export = withFirebaseModularHeaders;
