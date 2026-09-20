import { describe, expect, it } from 'vitest'
import { DRIFT_THRESHOLD, MIN_WORDS, measureThinking, verdict } from '../src/drift.ts'

/** 造一段「中文思考」：中文句子为主体，中间夹任意多个英文标识符。 */
function chineseWithIdentifiers(count: number): string {
  const identifiers = Array.from({ length: count }, (_, index) => `identifier${index}`).join(' ')
  return `这一段是中文的推理过程，中间引用了 ${identifiers} 这些标识符，`
    + '但它们只是名字而已，句子本身仍然是中文的，语序和连接词都是中文的。'
}

describe('measureThinking', () => {
  it('分开统计中文与英文，密度只由英文词决定', () => {
    const metrics = measureThinking('读 compactNow 的实现')
    expect(metrics.cjk).toBe(4)
    expect(metrics.words).toBe(1)
    expect(metrics.funcWords).toBe(0)
    expect(metrics.funcDensity).toBe(0)
  })

  it('空文本返回全零且不产生 NaN', () => {
    const metrics = measureThinking('')
    expect(metrics).toEqual({ chars: 0, cjk: 0, cjkRatio: 0, words: 0, funcWords: 0, funcDensity: 0 })
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
