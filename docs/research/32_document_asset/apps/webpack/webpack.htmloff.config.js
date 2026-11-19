// The experiment switched off: `.html` is no longer a module type of its own, and `new URL(...)` emits an asset.
const base = require('./webpack.config.js');

module.exports = { ...base, experiments: { html: false } };
