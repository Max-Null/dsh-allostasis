import { describe, expect, it } from 'vitest'
import { anchorText } from '../src/anchor.ts'
import { measureThinking } from '../src/drift.ts'

describe('anchorText', () => {
  it('说清是哪一步漂移、漂了多少', () => {
    const metrics = measureThinking(
      'The surface has a node zero and it must be replaced before the next step starts, '
      + 'because the agent loop reads the surface when it prepares the request.',
    )
    const text = anchorText(3, 7, metrics)
    expect(text).toContain('turn 3 step 7')
    expect(text).toContain(metrics.funcDensity.toFixed(2))
    expect(text).toContain(String(metrics.words))
  })

  it('点明引用英文标识符是正常的——否则模型会不敢写代码符号', () => {
    const text = anchorText(1, 1, measureThinking('placeholder'))
    expect(text).toContain('引用英文标识符是正常的')
    expect(text).toContain('整句英文')
  })

  it('给出的位置来自被检测的那一步，而不是当前步', () => {
    const text = anchorText(2, 9, measureThinking('placeholder'))
    expect(text).toContain('turn 2 step 9')
    expect(text).not.toContain('turn 1')
  })
})
