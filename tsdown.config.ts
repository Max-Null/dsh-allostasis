/**
 * 浏览器半边的构建配置。
 *
 * host 半边由 `tsc -p tsconfig.build.json` 逐文件转译到 `dist/`；浏览器半边走这里的
 * 单入口 bundle。两者形态不同是硬约束：DSH 的 client loader 要求 `client.js` 是 CJS、
 * 且自注册到 `window.__ModuleLoader__`，而 tsc 只会把 `.tsx` 逐文件转成 ESM。
 *
 * **包装走 `renderChunk` 插件，不用 `outputOptions.banner/footer/intro`**：2026-10-01 用
 * 探针反复对照后发现，那三个字段一旦出现在 `outputOptions` 里，rolldown 就会安静地写出
 * 0 字节的 `client.js`（`entryFileNames` 单独使用正常，同一份字段换个写法时好时坏，不受
 * 入口是 hello-world 还是真实源码影响）。自己拼包装文本没有这个不确定性，也顺带把
 * `intro` 提供的 `module`/`exports` 与产物形态的关系写明在这里。
 *
 * 外部化清单照 DSH 的模块表基线：react 家族、cordis、ui-primitives 由 loader 的 require
 * 提供，其余（含 i18n 字典、组件代码）打进 bundle。跨插件的值导入不走这里——
 * 那会破坏模块表身份，属于被禁止的形态。
 *
 * 设计出处：`docs/设计/2026-09-30-空回合检测与可见化.md` §十
 */
import type { TsdownPlugin, UserConfig } from 'tsdown'

const ID = '@max-null/dsh-allostasis'

/** loader 的模块表能回答的说明符；不在表里的说明符一律打包进 bundle。 */
const EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-primitives',
]

/**
 * 把入口 chunk 包成 loader 的工厂注册。
 *
 * 未包装的产物以 `Object.defineProperty(exports, …)` 开头、以 `exports.apply = apply` 结尾，
 * 所以工厂体里必须先给出 `module` 与 `exports` 两个局部名。
 * @param id - 插件 id，写进 `__ModuleLoader__.load` 的注册项。
 * @returns 只改写入口 chunk 的 tsdown 插件。
 */
function moduleLoaderWrap(id: string): TsdownPlugin {
  return {
    name: 'dsh-module-loader-wrap',
    renderChunk(code, chunk) {
      if (!chunk.isEntry) return null
      const wrapped = `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {\n`
        + 'var module = { exports: {} }; var exports = module.exports;\n'
        + code
        + '\nreturn module.exports; } });\n'
      return { code: wrapped, map: null }
    },
  }
}

const clientConfig: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.tsx' },
  // 与 host 半边同落 dist/：package.json 的 files 已经收 `dist`，
  // exports 只需多一条 `./client`。clean 必须关掉，否则会抹掉上面 tsc 的产物。
  outDir: 'dist',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: false,
  clean: false,
  deps: {
    // 只声明「什么留在外面」。反过来再写一条 `alwaysBundle` 会让它对每个模块都为真
    // （包括入口自己），tsdown 的依赖判定随之失效。
    neverBundle: [...EXTERNALS],
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  outputOptions: { entryFileNames: 'client.js' },
  plugins: [moduleLoaderWrap(ID)],
}

export default [clientConfig]
