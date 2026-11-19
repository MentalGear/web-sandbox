// Plain Rollup: only what is needed to find the package in node_modules.
import { nodeResolve } from '@rollup/plugin-node-resolve';

export default {
  input: 'main.js',
  output: { dir: 'dist', format: 'es' },
  plugins: [nodeResolve()],
};
