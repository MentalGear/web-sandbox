// The defaults: no rule, no plugin. The index.html is the static one beside the bundle (no HTML plugin).
const path = require('node:path');

module.exports = {
  mode: 'production',
  entry: './main.js',
  output: { path: path.resolve(__dirname, 'dist') },
  devServer: { static: { directory: path.resolve(__dirname, 'public') }, port: Number(process.env.PORT), host: '127.0.0.1' },
};
