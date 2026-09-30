/**
 * 浏览器半边的构建配置。
 *
 * host 半边由 `tsc -p tsconfig.build.json` 逐文件转译到 `dist/`；浏览器半边走这里的
 * 单入口 bundle。两者形态不同是硬约束：DSH 的 client loader 要求 `client.js` 是 CJS、
 * 且自注册到 `window.__ModuleLoader__`（banner/footer 就是那层协议），而 tsc 只会把
 * `.tsx` 逐文件转成 ESM，做不到这件事。
 *
 * 外部化清单照 DSH 的模块表基线：react 家族、cordis、ui-primitives 由 loader 的 require
 * 提供，其余（含 i18n 字典、组件代码）一律打进 bundle。跨插件的值导入不走这里——
 * 那会破坏模块表身份，属于被禁止的形态。
 *
 * 设计出处：`docs/设计/2026-09-30-空回合检测与可见化.md` §十
 */
import type { UserConfig } from 'tsdown'

const ID = '@max-null/dsh-allostasis'

/** loader 的模块表能回答的说明符；不在表里的说明符一律打包进 bundle。 */
const EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-primitives',
]

const clientConfig: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.tsx' },
  // 与 host 半边同落 dist/：package.json 的 files 已经收 `dist`，
  // exports 只需多一条 `./client`。
  outDir: 'dist',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  // host 提供的字节不经压缩传输，首屏体积直接等于这段产物。
  minify: true,
  sourcemap: false,
  clean: false,
  deps: {
    neverBundle: [...EXTERNALS],
    alwaysBundle: (id: string) => !EXTERNALS.includes(id),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    codeSplitting: false,
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {}; var exports = module.exports;',
  },
}

export default [clientConfig]
