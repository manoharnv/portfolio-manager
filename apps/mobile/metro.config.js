// Metro, configured for the pnpm workspace (Expo "Work with monorepos" guide).
//
// Two things matter here:
//   1. `watchFolders` must include the workspace root so Metro sees
//      `packages/core/dist` change and rebuilds the bundle.
//   2. `nodeModulesPaths` must list BOTH the app's own `node_modules` and the
//      workspace root's, because pnpm's isolated linker puts the real packages
//      under `<root>/node_modules/.pnpm` and symlinks them in.
//
// Hierarchical lookup is deliberately left ON (Expo's guide disables it for
// npm/yarn workspaces). pnpm's isolated layout gives every package its own
// nested `node_modules`; turning the walk-up off would make `zod` unresolvable
// from inside `@pm/core`.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
// Symlink resolution and package `exports` are already on by default in
// Expo's Metro config (expo-doctor flags re-stating them), which is what lets
// `@pm/core` resolve through its `exports` map to `dist/index.js`.

module.exports = config;
