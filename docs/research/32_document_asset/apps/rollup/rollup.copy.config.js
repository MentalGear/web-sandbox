// Plain Rollup plus a copy of the file to where the unchanged URL expression lands: beside the app's bundle.
import { nodeResolve } from '@rollup/plugin-node-resolve';
import copy from 'rollup-plugin-copy';

export default {
  input: 'main.js',
  output: { dir: 'dist', format: 'es' },
  plugins: [nodeResolve(), copy({ targets: [{ src: 'node_modules/fake-sealed/sealed-document.html', dest: 'dist' }], hook: 'writeBundle' })],
};
