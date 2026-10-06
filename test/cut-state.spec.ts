import { describe, expect, it } from 'vitest'
import { cutBeforeStopping, NO_CUT, recordCut, type CutLedger, type CutRecord } from '../src/cut/state.ts'

/** 一次掐断的现场读数（内容与判据无关，这里只当载荷用）。 */
function record(chars = 24, chunks = 12): CutRecord {
  return {
    chars,
    chunks,
    reading: { units: 12, repeated: 12, ratio: 1 },
    top: [{ unit: '好', count: 12 }],
  }
}

describe('recordCut', () => {
  it('首次掐断从空账本起步', () => {
    const ledger = recordCut(undefined, record())
    expect(ledger).toEqual({ total: 1, pending: 1, cutTurn: Number.NaN, last: record() })
  })

  it('同一个 turn 里连掐两次：pending 记两次，cutTurn 不变', () => {
    // 每次掐断都要换回一次续跑，所以 pending 不是布尔量（现场日志里连掐两次是常态）。
    const first = recordCut(undefined, record())
    const second = recordCut(first, record(48, 24))
    expect(second.total).toBe(2)
    expect(second.pending).toBe(2)
    expect(second.last?.chunks).toBe(24)
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
    const verdict = cutBeforeStopping(ledger, 3)
    expect(verdict.skip).toBe(true)
    expect(verdict.resume).toBe(true)
    expect(verdict.ledger.pending).toBe(0)
    expect(verdict.ledger.cutTurn).toBe(3)
    expect(verdict.ledger.total).toBe(1)
    // 现场读数留着——续跑文案要用它。
    expect(verdict.ledger.last).toEqual(record())
  })

  it('同一 turn 的第二次查账（turn-stopping 可能重入）：仍然跳过，但不再续跑', () => {
    // 第二次若不跳过，那条纯 reasoning 的消息会立刻被判成空回合，于是同一次静默被提醒两遍。
    const first = cutBeforeStopping(recordCut(undefined, record()), 3)
    const second = cutBeforeStopping(first.ledger, 3)
    expect(second.skip).toBe(true)
    expect(second.resume).toBe(false)
    expect(second.ledger).toEqual(first.ledger)
  })

  it('下一次掐断重新点燃续跑', () => {
    const first = cutBeforeStopping(recordCut(undefined, record()), 3)
    const again = cutBeforeStopping(recordCut(first.ledger, record(96, 48)), 4)
    expect(again.skip).toBe(true)
    expect(again.resume).toBe(true)
    expect(again.ledger.cutTurn).toBe(4)
  })

  it('别的 turn 与掐断无关：既不跳过也不续跑', () => {
    const ledger = cutBeforeStopping(recordCut(undefined, record()), 3).ledger
    const other = cutBeforeStopping(ledger, 4)
    expect(other.skip).toBe(false)
    expect(other.resume).toBe(false)
    expect(other.ledger).toEqual(ledger)
  })

  it('从没掐断过时是空操作——silentTurn 的既有行为一个字都不变', () => {
    const verdict = cutBeforeStopping(undefined, 3)
    expect(verdict).toEqual({ ledger: NO_CUT, skip: false, resume: false })
  })
})
