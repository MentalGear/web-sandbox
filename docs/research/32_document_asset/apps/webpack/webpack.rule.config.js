// One rule: the file is an asset module (a copy, named by its content hash), not a page for webpack's HTML support.
const base = require('./webpack.config.js');

module.exports = { ...base, module: { rules: [{ test: /\.html$/i, type: 'asset/resource' }] } };
