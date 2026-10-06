import { describe, expect, it } from 'vitest'
import { cutBeforeStopping, NO_CUT, recordCut, type CutLedger, type CutRecord } from '../src/cut/state.ts'
import { STREAM_CUT_MAX_RESUMES } from '../src/cut/stream.ts'

/** 一次掐断的现场读数（内容与判据无关，这里只当载荷用）。 */
function record(chars = 24, chunks = 12): CutRecord {
  return {
    chars,
    chunks,
    reading: { units: 12, repeated: 12, ratio: 1 },
    top: [{ unit: '好', count: 12 }],
  }
}

/** 把一连串掐断按同一个 turn 逐次喂进查账，返回每次的判定。 */
function bursts(count: number, turn: number, max = STREAM_CUT_MAX_RESUMES) {
  let ledger: CutLedger | undefined
  const verdicts = []
  for (let i = 0; i < count; i += 1) {
    ledger = recordCut(ledger, record())
    const verdict = cutBeforeStopping(ledger, turn, max)
    ledger = verdict.ledger
    verdicts.push(verdict)
  }
  return verdicts
}

describe('recordCut', () => {
  it('首次掐断从空账本起步', () => {
    const ledger = recordCut(undefined, record())
    expect(ledger).toEqual({
      total: 1,
      pending: 1,
      cutTurn: Number.NaN,
      resumes: 0,
      last: record(),
    })
  })

  it('同一个 turn 里连掐两次：pending 记两次，cutTurn 不变', () => {
    // 每次掐断都要换回一次续跑，所以 pending 不是布尔量（现场日志里连掐两次是常态）。
    const first = recordCut(undefined, record())
    const second = recordCut(first, record(48, 24))
    expect(second.total).toBe(2)
    expect(second.pending).toBe(2)
    expect(second.last?.chunks).toBe(24)
  })

  it('掐断本身不推进 resumes——能不能续跑要等回合收尾才知道', () => {
    const ledger = recordCut(recordCut(undefined, record()), record())
    expect(ledger.resumes).toBe(0)
  })

  it('不修改传进来的账本——状态推进是返回新对象', () => {
    const before = recordCut(undefined, record())
    const snapshot: CutLedger = { ...before }
    recordCut(before, record())
    expect(before).toEqual(snapshot)
  })
})

describe('cutBeforeStopping', () => {
  it('本 turn 有新掐断：跳过判定并续跑，pending 被消费', () => {
    const ledger = recordCut(undefined, record())
    const verdict = cutBeforeStopping(ledger, 3, STREAM_CUT_MAX_RESUMES)
    expect(verdict.skip).toBe(true)
    expect(verdict.resume).toBe(true)
    expect(verdict.exhausted).toBe(false)
    expect(verdict.ledger.pending).toBe(0)
    expect(verdict.ledger.cutTurn).toBe(3)
    expect(verdict.ledger.total).toBe(1)
    expect(verdict.ledger.resumes).toBe(1)
    // 现场读数留着——续跑文案要用它。
    expect(verdict.ledger.last).toEqual(record())
  })

  it('同一 turn 的第二次查账（turn-stopping 可能重入）：仍然跳过，但不再续跑', () => {
    // 第二次若不跳过，那条纯 reasoning 的消息会立刻被判成空回合，于是同一次静默被提醒两遍。
    const first = cutBeforeStopping(recordCut(undefined, record()), 3, STREAM_CUT_MAX_RESUMES)
    const second = cutBeforeStopping(first.ledger, 3, STREAM_CUT_MAX_RESUMES)
    expect(second.skip).toBe(true)
    expect(second.resume).toBe(false)
    // 重入不是「配额用完」——诊断行要说清是哪一种。
    expect(second.exhausted).toBe(false)
    expect(second.ledger).toEqual(first.ledger)
  })

  it('下一次掐断重新点燃续跑', () => {
    const first = cutBeforeStopping(recordCut(undefined, record()), 3, STREAM_CUT_MAX_RESUMES)
    const again = cutBeforeStopping(recordCut(first.ledger, record(96, 48)), 4, STREAM_CUT_MAX_RESUMES)
    expect(again.skip).toBe(true)
    expect(again.resume).toBe(true)
    expect(again.ledger.cutTurn).toBe(4)
  })

  it('别的 turn 与掐断无关：既不跳过也不续跑', () => {
    const ledger = cutBeforeStopping(recordCut(undefined, record()), 3, STREAM_CUT_MAX_RESUMES).ledger
    const other = cutBeforeStopping(ledger, 4, STREAM_CUT_MAX_RESUMES)
    expect(other.skip).toBe(false)
    expect(other.resume).toBe(false)
    expect(other.exhausted).toBe(false)
    expect(other.ledger).toEqual(ledger)
  })

  it('从没掐断过时是空操作——silentTurn 的既有行为一个字都不变', () => {
    const verdict = cutBeforeStopping(undefined, 3, STREAM_CUT_MAX_RESUMES)
    expect(verdict).toEqual({ ledger: NO_CUT, skip: false, resume: false, exhausted: false })
  })
})

describe('每 turn 的续跑上限（§九.7）', () => {
  it('前三次照常续跑，第四次起只跳过、不再续跑', () => {
    const verdicts = bursts(5, 7)
    expect(verdicts.slice(0, 3).map(verdict => verdict.resume)).toEqual([true, true, true])
    expect(verdicts.slice(3).map(verdict => verdict.resume)).toEqual([false, false])
    // 超限的那两次仍然「跳过空回合判定」——静默依旧是本插件造成的，不能退回去补一次生成。
    expect(verdicts.slice(3).map(verdict => verdict.skip)).toEqual([true, true])
    expect(verdicts.slice(3).map(verdict => verdict.exhausted)).toEqual([true, true])
  })

  it('超限之后每一次掐断都仍然被消费掉，pending 不留到下个 turn', () => {
    const verdicts = bursts(6, 7)
    expect(verdicts.every(verdict => verdict.ledger.pending === 0)).toBe(true)
    expect(verdicts[5]?.ledger.total).toBe(6)
  })

  it('计数按 turn 重置：换一个 turn 就重新拿到完整配额', () => {
    const sameTurn = bursts(4, 7)
    expect(sameTurn[3]?.resume).toBe(false)
    const nextTurn = cutBeforeStopping(recordCut(sameTurn[3]?.ledger, record()), 8, STREAM_CUT_MAX_RESUMES)
    expect(nextTurn.resume).toBe(true)
    expect(nextTurn.exhausted).toBe(false)
    expect(nextTurn.ledger.resumes).toBe(1)
  })

  it('上限可调：1 表示同一个 turn 只续跑一次', () => {
    const verdicts = bursts(3, 7, 1)
    expect(verdicts.map(verdict => verdict.resume)).toEqual([true, false, false])
    expect(verdicts[1]?.exhausted).toBe(true)
  })

  it('上限提高时按新值放行——它是参数，不是写死的常数', () => {
    const verdicts = bursts(5, 7, 5)
    expect(verdicts.every(verdict => verdict.resume)).toBe(true)
    expect(verdicts[4]?.ledger.resumes).toBe(5)
  })

  it('缺省上限是 3', () => {
    expect(STREAM_CUT_MAX_RESUMES).toBe(3)
  })

  it('上限 0 = 只掐不续：每一次掐断都走超限分支，跳过一次不少', () => {
    // 0 不是「没有上限」，是「配额为零」——`resume` 恒假、`exhausted` 恒真、`skip` 恒真。
    // 最后一条尤其重要：那一步的静默仍然是我们造成的，不能退回去补一次生成。
    const verdicts = bursts(4, 7, 0)
    expect(verdicts.map(verdict => verdict.resume)).toEqual([false, false, false, false])
    expect(verdicts.map(verdict => verdict.exhausted)).toEqual([true, true, true, true])
    expect(verdicts.map(verdict => verdict.skip)).toEqual([true, true, true, true])
    expect(verdicts.every(verdict => verdict.ledger.pending === 0)).toBe(true)
    expect(verdicts[3]?.ledger.total).toBe(4)
  })

  it('上限 0 与「重入」在返回值上分得开——前者 exhausted 为真，后者为假', () => {
    // 两条路径都是 `resume: false`；混在一起时，诊断行就说不清是机制拦住了还是漏发了。
    const stopped = cutBeforeStopping(recordCut(undefined, record()), 7, 0)
    const reentered = cutBeforeStopping(recordCut(undefined, record()), 7, STREAM_CUT_MAX_RESUMES)
    const again = cutBeforeStopping(reentered.ledger, 7, STREAM_CUT_MAX_RESUMES)
    expect(stopped).toMatchObject({ skip: true, resume: false, exhausted: true })
    expect(again).toMatchObject({ skip: true, resume: false, exhausted: false })
  })

  it('上限 0 下换 turn 也是只掐不续——它不随 turn 变成配额', () => {
    const first = bursts(2, 7, 0)
    const nextTurn = cutBeforeStopping(recordCut(first[1]?.ledger, record()), 8, 0)
    expect(nextTurn.resume).toBe(false)
    expect(nextTurn.exhausted).toBe(true)
    expect(nextTurn.skip).toBe(true)
  })
})
