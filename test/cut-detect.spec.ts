import { describe, expect, it } from 'vitest'
import { createStreamDetector } from '../src/cut/detect.ts'
import {
  isSemanticUnit,
  measureRepetition,
  MIN_UNITS,
  REPEAT_MIN_COUNT,
  REPETITION_THRESHOLD,
  repetitionVerdict,
  UNIT_SEPARATOR,
} from '../src/repetition.ts'

/**
 * 把一段文本按固定宽度切成增量喂进扫描器，每个位置与「对累积文本调一次原实现」比四元组。
 *
 * 这是 §11.6 的第一项，也是整个三期判据的正确性底座：流上判定必须与步骤边界的判定
 * 指向同一个结论，否则「掐断」与「提醒」就是两套口径。
 * @param text - 待回放文本。
 * @param width - 每个增量取几个字符。
 * @param threshold - 判定阈值。
 * @returns 不一致的位置数，以及比对过的位置数。
 */
function replay(text: string, width: number, threshold = REPETITION_THRESHOLD): { bad: number; at: number } {
  const detector = createStreamDetector(threshold)
  const chars = Array.from(text)
  let accumulated = ''
  let bad = 0
  for (let at = 0; at < chars.length; at += width) {
    const chunk = chars.slice(at, at + width).join('')
    accumulated += chunk
    const fired = detector.push(chunk)
    const reading = detector.reading()
    const whole = measureRepetition(accumulated)
    const expected = repetitionVerdict(whole, threshold) === 'loop'
    if (reading.units !== whole.units || reading.repeated !== whole.repeated
      || reading.ratio !== whole.ratio || fired !== expected) bad += 1
  }
  return { bad, at: chars.length }
}

/** 退化样本、混合样本、代码围栏样本、无分隔符收尾、真实中文段落。 */
const SAMPLES: ReadonlyArray<{ name: string; text: string }> = [
  { name: '纯复读（好。×40）', text: '好。'.repeat(40) },
  { name: '复读里夹着不同句', text: '好。\n好。\n不一样的一句\n好。\n好。\n执行。\n执行。\n执行。' },
  { name: '代码围栏与实义单元混排', text: '```ts\nconst a = 1\n```\n汉字单元。汉字单元。汉字单元。英文 word 也算。' },
  { name: '没有分隔符的收尾段', text: '甲。乙。丙。未收尾的尾段' },
  { name: '恰好压在单元门槛上', text: '碎0。碎1。碎2。碎3。碎4。碎5。碎6。碎7。碎8。碎9。碎10。碎11。' },
  { name: '恰好跨过重复门槛', text: '同。\n同。\n同。\n独一。\n独二。' },
  { name: '带引号、括号与英文标识符的段落', text: '先看 `measureRepetition` 的口径（它切分后 trim）。再看 `counts` Map 的累加。' },
]

describe('流上判据与 measureRepetition 口径一致', () => {
  it.each([...SAMPLES])('逐字符喂入：$name', ({ text }) => {
    expect(replay(text, 1)).toEqual({ bad: 0, at: Array.from(text).length })
  })

  it.each([...SAMPLES])('逐 3 字符喂入：$name', ({ text }) => {
    expect(replay(text, 3).bad).toBe(0)
  })

  it.each([...SAMPLES])('整段一次性喂入：$name', ({ text }) => {
    // 宽度大于全文长度时退化成「全文一次调用」，与原实现必须逐字段相等。
    expect(replay(text, text.length + 1).bad).toBe(0)
  })

  it('三个阈值下都一致——判定差只来自阈值，不来自维护方式', () => {
    for (const threshold of [0.5, 0.6, 0.9]) {
      for (const sample of SAMPLES) {
        expect(replay(sample.text, 2, threshold).bad, `${sample.name} @ ${threshold}`).toBe(0)
      }
    }
  })

  it('增量切分与导出常量同源：换掉分隔符就不再切分', () => {
    // 反证用：容器里的「甲\n乙」按 UNIT_SEPARATOR 是 2 个单元，若切分口径被改成别的字符，
    // 这里的读数会变成 1——这条断言把「复用同一份切分」钉在测试里。
    const detector = createStreamDetector()
    detector.push('甲\n乙')
    expect(detector.reading().units).toBe(2)
    expect('甲\n乙'.split(UNIT_SEPARATOR)).toEqual(['甲', '乙'])
    expect(isSemanticUnit('甲')).toBe(true)
  })
})

describe('增量维护的那两处细节', () => {
  it('repeated 只在计数跨过 REPEAT_MIN_COUNT 时补记', () => {
    const detector = createStreamDetector()
    detector.push('同。')
    expect(detector.reading().repeated).toBe(0)
    detector.push('同。')
    expect(detector.reading().repeated).toBe(0)
    detector.push('同。')
    // 2 → 3 时把那 3 次一次性补记。
    expect(detector.reading().repeated).toBe(REPEAT_MIN_COUNT)
    detector.push('同。')
    expect(detector.reading().repeated).toBe(REPEAT_MIN_COUNT + 1)
  })

  it('未收尾的尾段用临时值参与判定，但不写回状态', () => {
    // 写回的话，同一行会被后续增量重复计入——这是设计文档 §九.2 点名的那个细节。
    const detector = createStreamDetector()
    detector.push('同。同。同。独')
    const first = detector.reading()
    const second = detector.reading()
    expect(second).toEqual(first)
    // 尾段「独」贡献 1 个单元：3 个「同」+ 1 个「独」。
    expect(first.units).toBe(4)
    expect(first.repeated).toBe(REPEAT_MIN_COUNT)
    // 它被后续增量续写并收尾之前，不会进 counts。
    detector.push('一文。')
    expect(detector.reading().units).toBe(4)
    expect(detector.reading().repeated).toBe(REPEAT_MIN_COUNT)
  })

  it('尾段续写会让它从临时单元变成一个真单元，计数不会重复', () => {
    const detector = createStreamDetector()
    detector.push('同。同。同。独')
    detector.push('一。')
    const reading = detector.reading()
    expect(reading.units).toBe(4)
    expect(reading.repeated).toBe(REPEAT_MIN_COUNT)
    expect(measureRepetition('同。同。同。独一。').units).toBe(4)
  })
})

describe('越线与门槛', () => {
  it('单元数不足 MIN_UNITS 时不判越线，即使全都在重复', () => {
    const detector = createStreamDetector()
    detector.push('好。'.repeat(MIN_UNITS - 1))
    expect(detector.reading().units).toBe(MIN_UNITS - 1)
    expect(detector.reading().ratio).toBe(1)
    // 门槛没到，`push` 的返回值仍是 false——与 `repetitionVerdict` 的 `insufficient` 一致。
    expect(detector.push('')).toBe(false)
  })

  it('单元数到达 MIN_UNITS 且 ratio 达标即越线', () => {
    const detector = createStreamDetector()
    detector.push('好。'.repeat(MIN_UNITS - 1))
    expect(detector.push('好。')).toBe(true)
    expect(detector.reading().units).toBe(MIN_UNITS)
    expect(detector.reading().ratio).toBe(1)
  })

  it('阈值是闭区间下界——0.5 的 ratio 判越线，0.49 不判', () => {
    // 6 个「同」+ 6 个独立单元 = 12 个单元、repeated = 6 → ratio = 0.5。
    const text = `${'同。'.repeat(6)}${Array.from({ length: 6 }, (_, i) => `独${i}。`).join('')}`
    expect(measureRepetition(text).ratio).toBe(0.5)
    expect(createStreamDetector(0.5).push(text)).toBe(true)
    expect(createStreamDetector(0.51).push(text)).toBe(false)
  })

  it('ratio 回落时不 latch——每次 push 报的都是此刻的判定', () => {
    const detector = createStreamDetector()
    detector.push('好。'.repeat(MIN_UNITS))
    expect(detector.push('好。')).toBe(true)
    detector.push('独一。独二。独三。独四。独五。独六。独七。独八。独九。独十。独十一。独十二。独十三。独十四。独十五。独十六。独十七。独十八。独十九。独二十。')
    const reading = detector.reading()
    expect(reading.ratio).toBeLessThan(0.5)
    expect(measureRepetition('好。'.repeat(MIN_UNITS + 1) + '独一。独二。独三。独四。独五。独六。独七。独八。独九。独十。独十一。独十二。独十三。独十四。独十五。独十六。独十七。独十八。独十九。独二十。').ratio).toBe(reading.ratio)
  })
})

describe('读数与诊断行', () => {
  it('describe 给出三格读数', () => {
    const detector = createStreamDetector()
    detector.push('好。'.repeat(MIN_UNITS))
    expect(detector.describe()).toBe(`units=${MIN_UNITS} repeated=${MIN_UNITS} ratio=100%`)
  })

  it('frequent 的排序与 measureRepetition 的 top 一致', () => {
    const text = `${'unit0。'.repeat(5)}${'unit1。'.repeat(4)}${'unit2。'.repeat(3)}独一。独二。`
    const detector = createStreamDetector()
    detector.push(text)
    expect(detector.frequent(5)).toEqual(measureRepetition(text).top)
  })

  it('frequent 只收达标单元，并遵守 limit', () => {
    const detector = createStreamDetector()
    detector.push('只出现两次。只出现两次。其它一次。')
    expect(detector.frequent(5)).toEqual([])
  })
})
