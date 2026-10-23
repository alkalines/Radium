module.exports = function (api) {
  api.cache(true);

  return {
    // Disable automatic plugin insertion so Bundle Mode options have one owner.
    presets: [["babel-preset-expo", { worklets: false, reanimated: false }]],
    plugins: [
      [
        "react-native-worklets/plugin",
        { bundleMode: true, importForwarding: { moduleNames: ["remend"] } },
      ],
    ],
  };
};
