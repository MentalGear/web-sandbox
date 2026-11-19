// @rollup/plugin-url, the other plugin people add for assets: it acts on imports, not on `new URL(...)`.
import { nodeResolve } from '@rollup/plugin-node-resolve';
import url from '@rollup/plugin-url';

export default {
  input: 'main.js',
  output: { dir: 'dist', format: 'es' },
  plugins: [nodeResolve(), url({ include: ['**/*.html'], limit: 0 })],
};
