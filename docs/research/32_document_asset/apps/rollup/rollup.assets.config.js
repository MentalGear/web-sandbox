// The plugin people add for `new URL('./file', import.meta.url)`: it emits the file and rewrites the URL.
import { nodeResolve } from '@rollup/plugin-node-resolve';
import { importMetaAssets } from '@web/rollup-plugin-import-meta-assets';

export default {
  input: 'main.js',
  output: { dir: 'dist', format: 'es' },
  plugins: [nodeResolve(), importMetaAssets()],
};
