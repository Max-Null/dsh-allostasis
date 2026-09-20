import { describe, expect, it } from 'vitest'
import { admitAnchor, MAX_ANCHORS_PER_TURN } from '../src/throttle.ts'

describe('admitAnchor', () => {
  it('首次放行并开始计数', () => {
    expect(admitAnchor(undefined, 1)).toEqual({ lastTurn: 1, inTurn: 1, count: 1 })
  })

  it('同一 turn 内第二次被拒——实测里 3 连注就是这么来的', () => {
    const first = admitAnchor(undefined, 1)
    expect(admitAnchor(first, 1)).toBeUndefined()
  })

  it('下一个 turn 重新放行，累计次数继续增长', () => {
    const first = admitAnchor(undefined, 1)
    expect(admitAnchor(first, 2)).toEqual({ lastTurn: 2, inTurn: 1, count: 2 })
  })

  it('状态不可变：反复用同一份旧状态求值，结果始终一致', () => {
    const first = admitAnchor(undefined, 5)
    const snapshot = { ...first }
    admitAnchor(first, 5)
    admitAnchor(first, 6)
    expect(first).toEqual(snapshot)
  })

  it('同一 turn 反复求值只放行上限那么多次', () => {
    let state = admitAnchor(undefined, 3)
    expect(state).toBeDefined()
    let admitted = 1
    for (let i = 0; i < 5; i += 1) {
      const next = admitAnchor(state, 3)
      if (next !== undefined) {
        admitted += 1
        state = next
      }
    }
    expect(admitted).toBe(MAX_ANCHORS_PER_TURN)
  })

  it('turn 号相同但跨会话互不影响——状态由调用方按会话持有', () => {
    const sessionA = admitAnchor(undefined, 7)
    const sessionB = admitAnchor(undefined, 7)
    expect(sessionA).toEqual(sessionB)
    expect(admitAnchor(sessionB, 7)).toBeUndefined()
  })
})
