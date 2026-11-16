import { describe, expect, it } from 'vitest'
import { DRIFT_THRESHOLD, MIN_WORDS, measureThinking, stripQuotations, verdict } from '../src/drift.ts'

/** 造一段「中文思考」：中文句子为主体，中间夹任意多个英文标识符。 */
function chineseWithIdentifiers(count: number): string {
  const identifiers = Array.from({ length: count }, (_, index) => `identifier${index}`).join(' ')
  return `这一段是中文的推理过程，中间引用了 ${identifiers} 这些标识符，`
    + '但它们只是名字而已，句子本身仍然是中文的，语序和连接词都是中文的。'
}

describe('measureThinking', () => {
  it('标识符、缩写、驼峰名不进分母——它们证明在读代码，不证明在用英文思考', () => {
    expect(measureThinking('读 readSurface 的 API 与 funcDensity').words).toBe(0)
    expect(measureThinking('读 surface 的节点').words).toBe(1)
    expect(measureThinking('读 the 的 the 节点').funcWords).toBe(2)
  })

  it('空文本返回全零且不产生 NaN', () => {
    const metrics = measureThinking('')
    expect(metrics).toEqual({ chars: 0, cjk: 0, cjkRatio: 0, words: 0, funcWords: 0, funcDensity: 0 })
  })
})

describe('stripQuotations', () => {
  it('剥掉围栏代码块、行内代码与成对引号内的内容', () => {
    const text = '先看 `readSurface` 的实现：\n```ts\nconst surface = prime()\n```\n'
      + '文档说「the surface must be replaced before the read」——按这个来。'
    const stripped = stripQuotations(text)
    expect(stripped).not.toContain('prime')
    expect(stripped).not.toContain('readSurface')
    expect(stripped).not.toContain('must be replaced')
    expect(stripped).toContain('按这个来')
  })

  it('单引号不剥——英文行文里的缩写不该被当成引用删掉', () => {
    expect(stripQuotations("it doesn't matter")).toContain("doesn't")
  })
})

describe('verdict', () => {
  it('中文思考里夹大量英文标识符，仍判为中文', () => {
    const metrics = measureThinking(chineseWithIdentifiers(60))
    expect(metrics.words).toBeGreaterThanOrEqual(MIN_WORDS)
    expect(metrics.funcDensity).toBeLessThan(DRIFT_THRESHOLD)
    expect(verdict(metrics)).toBe('chinese')
  })

  it('整句英文判为漂移', () => {
    const metrics = measureThinking(
      'The surface has a node zero and it must be replaced before the next step starts, '
      + 'because the agent loop reads the surface when it prepares the request and a replacement '
      + 'that lands after that read would not be visible to the model at all. So the order matters '
      + 'here: first the prime, then the replacement, and only then the call itself.',
    )
    expect(metrics.words).toBeGreaterThanOrEqual(MIN_WORDS)
    expect(metrics.funcDensity).toBeGreaterThanOrEqual(DRIFT_THRESHOLD)
    expect(verdict(metrics)).toBe('drift')
  })

  it('英文词数不足时不下结论——小样本会把密度算飞', () => {
    // 这条在真实数据里的原型：26 个英文词、密度 0.192，但整句是中文。
    const metrics = measureThinking('读 the 这个 the 词 the 密度 the 就 the 失真 the 了 the 啊 the 呀 the 哦 the 嗯 the 哈')
    expect(metrics.words).toBeLessThan(MIN_WORDS)
    expect(verdict(metrics)).toBe('insufficient')
  })

  it('恰好达到词数门槛时开始判定', () => {
    const identifiers = Array.from({ length: MIN_WORDS }, (_, index) => `identifier${index}`).join(' ')
    const metrics = measureThinking(`${identifiers} 这一句是中文的。`)
    expect(metrics.words).toBe(MIN_WORDS)
    expect(verdict(metrics)).toBe('chinese')
  })
})

describe('verdict · 中文思考引用英文（2026-11-16 误判回归）', () => {
  /** 真实形态：中文推理里整句抄一段英文技能描述，引号只包住引用本身。 */
  const quotedSkillDescription = '用户问的是插件能力，属于「Check DSH\'s optional plugins when the user asks how to do '
    + 'or use something in this app, whether it can, or says a capability is missing or should change: '
    + 'tools, input, thinking or title display, session search, terminals, worktrees, agent teams」这一句，'
    + '但这里是讨论自造插件设想，偏开发。先查工作区实际插件更直接，先查。'
    + '注意这个插件可能是我们自己的，或者是第三方的。查一下。开始。'

  it('引号包住的英文引用不进分母，中文主体因此不再越线', () => {
    expect(verdict(measureThinking(quotedSkillDescription))).not.toBe('drift')
  })

  it('没加引号的整段英文粘贴由中文兜底挡住——汉字更多，主体就是中文', () => {
    const pasted = 'The import plugin turns every conversation in the exported zip into one workspace session, '
      + 'and the embedded chat plugin renders the web chat client inside the app window, so the two of them '
      + 'together could in principle drive the agent loop with subscription quota instead of api billing. '
      + 'So the answer depends on how the quota is metered, which is the part I should verify before saying '
      + 'anything else about it. '
    const text = '用户问的是一个产品设想：把导出的对话变成会话，再借内嵌的网页版聊天界面去跑循环。'
      + '先理解这句话指什么——大概是说不用付接口费用，借免费额度来跑。'
      + '这是个需要查证的问题，不能凭想象回答。让我搜一下工作区，看看这两个插件分别是什么。'
      + '判断这个设想在技术上是否成立，给出诚实的评估。' + pasted
    const metrics = measureThinking(text)
    expect(metrics.words).toBeGreaterThanOrEqual(MIN_WORDS)
    expect(metrics.cjk).toBeGreaterThanOrEqual(metrics.words)
    expect(verdict(metrics)).toBe('chinese')
  })

  it('真漂移即便夹了行内代码与标识符，仍判为漂移', () => {
    const text = 'The surface has a node zero and it must be replaced before the next step starts, because '
      + 'the agent loop reads `surface` when it prepares the request, and a replacement that lands after '
      + 'that read would not be visible to the model at all. So the order matters here: first the prime, '
      + 'then the replacement, and only then the call itself.'
    const metrics = measureThinking(text)
    expect(metrics.cjk).toBe(0)
    expect(verdict(metrics)).toBe('drift')
  })
})
