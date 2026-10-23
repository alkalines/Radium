const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");
const { getBundleModeMetroConfig } = require("react-native-worklets/bundleMode");
const path = require("node:path");

const config = getDefaultConfig(__dirname);
// Worklets creates Markdown processor modules here during transformation.
config.watchFolders.push(
  path.join(path.dirname(require.resolve("react-native-worklets/package.json")), ".worklets"),
);

module.exports = withUniwindConfig(getBundleModeMetroConfig(config), {
  cssEntryFile: "./src/global.css",
  // Preserve the app's existing explicit rem base rather than the library default.
  polyfills: { rem: 16 },
});
