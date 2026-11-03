import { clientBundle } from '../tsdown.client.ts'

export default clientBundle('@deepseek-ai/dsh-client-ui-qifu-work-surface', ['lib/types/index.js', 'lib/types/invariant.js'], {
  hostPhase: true,
  companions: [{
    entry: ['lib/types/office-worker.js'],
    outDir: 'lib',
    format: ['cjs'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    copy: [{ from: 'src/assets/*', to: 'lib/assets' }],
  }],
})
