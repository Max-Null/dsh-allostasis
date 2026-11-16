/**
 * 思考语言漂移判定。
 *
 * 判据是**英文功能词密度** = 英文功能词数 / 英文词数，并要求英文词数达到门槛。
 * 实测依据（2026-09-20，会话 `session-3bf8bcfb`，156 条 `assistant/message`）：
 * 中文期中位密度 0.012、英文期中位 0.273–0.389，阈值 0.15 两群完全分离。词数门槛
 * 是必需的——中文期唯一的越线点（密度 0.192）只有 26 个英文词，小样本让密度失真。
 *
 * **密度单独一项会误判「中文思考里引用英文」。** 2026-11-16 在全库 9,642 条思考上
 * 复核：判成漂移的 149 步里有 121 步主体是中文（占 81%），形态是技能描述、README、
 * 报错原文被整段抄进思考——中文思考的英文词总量本来就小，一段引用就能把密度顶过线。
 * 两类样本的中文字数 / 英文词数比完全分开：被误判的 ≥1.47，真漂移的 ≤0.53。
 * 修法有三层，都做在度量侧，阈值与判定口径不变：
 *
 *   · **剥离明确标出的引用区**（{@link stripQuotations}）：围栏代码块、行内代码、
 *     成对引号内的内容不计入分母。
 *   · **只留自然语言词**（{@link naturalWords}）：标识符、缩写、驼峰名不进分母——
 *     它们证明「在读代码」，不证明「在用英文思考」。
 *   · **中文兜底**（{@link verdict}）：汉字数不少于英文词数时主体就是中文，不论密度。
 *     这一层管住没加引号的整段英文粘贴，剥离规则够不着它。
 *
 * 另外两个看起来更直观的指标不可用：
 *   · 中文字符占比：中文思考本来就大量夹英文标识符，实测中文期只有 0.19–0.37，
 *     与英文期的 0.00–0.15 区分度太小。
 *   · 最长连续英文游程：中文思考引用一段代码就会把它顶到 43，它测的是「引用了多长
 *     的代码」，不是「用什么语言思考」。
 *
 * 设计出处：`docs/设计/2026-09-20-应变-设计方案.md` §4.3
 * @module @max-null/dsh-allostasis/drift
 */

/** 英文功能词：中文思考引用英文标识符时不会带这些词。 */
const FUNC_WORDS = new Set(
  ('the is are was were and or but to of in that this with for it as be not if on at by from an a ' +
    'we i you they have has will can should would there which when what how so then than also all ' +
    'one two no yes do does did its their our my his her them these those been being more most some ' +
    'any each both into over after before while because however thus therefore instead about only ' +
    'just even still yet first second next last new same other such per here where who whose must ' +
    'may might shall').split(' '),
)

/**
 * 引用区的标记形态。
 *
 * 单引号刻意不列：英文行文里的缩写（`don't`）会连带被剥，那是在删正文。
 */
const QUOTED_PATTERNS: readonly RegExp[] = [
  /```[\s\S]*?```/g, // 围栏代码块
  /`[^`\n]*`/g, // 行内代码
  /「[^」\n]*」/g, // 直角引号，中文引文最常用的形态
  /『[^』\n]*』/g,
  /“[^”\n]*”/g,
  /"[^"\n]*"/g, // 英文双引号
]

/** 一段英文词的形态。 */
const NATURAL_WORD = /[A-Za-z]+(?:'[a-z]+)?/g

/** 功能词密度达到此值即判为漂移；中文期中位 0.012、英文期中位 0.273 以上。 */
export const DRIFT_THRESHOLD = 0.15

/** 判定所需的最少英文词数；低于此值只报数不判定，避免小样本把密度算飞。 */
export const MIN_WORDS = 50

/** 一条思考文本的量化结果。 */
export interface DriftMetrics {
  /** 文本总字符数。 */
  chars: number
  /** 中文字符数。 */
  cjk: number
  /** 中文字符占比，仅用于诊断，不参与判定。 */
  cjkRatio: number
  /** 英文词数——已剥离引用区、只算自然语言词。 */
  words: number
  /** 英文功能词数。 */
  funcWords: number
  /** 功能词密度——判据本体。 */
  funcDensity: number
}

/** 三态判定；词数不足时不下结论。 */
export type DriftVerdict = 'drift' | 'chinese' | 'insufficient'

/**
 * 剥掉明确标出的引用区。
 *
 * 引用进来的英文是「被引」而不是「我在用」：它不该进密度分母。剥不干净的那部分
 * （整段粘贴、没有引号）不是这条规则的事，由 {@link verdict} 的中文兜底挡住。
 * @param text - 一条思考原文。
 * @returns 只留主体行文的文本。
 */
export function stripQuotations(text: string): string {
  return QUOTED_PATTERNS.reduce((carry, pattern) => carry.replace(pattern, ' '), text)
}

/**
 * 挑出像自然语言的英文词。
 *
 * 排除单字母、全大写缩写（`API`）、含中间大写的驼峰名（`readSurface`）——这些在
 * 中文思考里大量出现，却是「在读代码」的证据。下划线与数字由词形正则直接切断。
 * @param text - 已经剥过引用区的文本。
 * @returns 计入分母的英文词。
 */
function naturalWords(text: string): string[] {
  return (text.match(NATURAL_WORD) ?? []).filter((word) => {
    if (word.length < 2) return false
    if (word === word.toUpperCase()) return false
    if (/[A-Z]/.test(word.slice(1))) return false
    return true
  })
}

/** 统计一条思考文本的各量。空文本返回全零。 */
export function measureThinking(text: string): DriftMetrics {
  const cjk = text.match(/[\u4e00-\u9fff]/g)?.length ?? 0
  const words = naturalWords(stripQuotations(text))
  const funcWords = words.filter(word => FUNC_WORDS.has(word.toLowerCase())).length
  return {
    chars: text.length,
    cjk,
    cjkRatio: text.length === 0 ? 0 : cjk / text.length,
    words: words.length,
    funcWords,
    funcDensity: words.length === 0 ? 0 : funcWords / words.length,
  }
}

/**
 * 对一次测量下判定。
 *
 * 汉字数不少于英文词数时直接判中文：主体行文是中文，密度再高也只是引用带来的。
 * 这一条比密度更硬——它不依赖引用有没有被标出来。
 * @param metrics - 量化结果。
 * @param threshold - 功能词密度阈值；缺省用 {@link DRIFT_THRESHOLD}。
 * @returns 三态判定。
 */
export function verdict(metrics: DriftMetrics, threshold: number = DRIFT_THRESHOLD): DriftVerdict {
  if (metrics.words < MIN_WORDS) return 'insufficient'
  if (metrics.cjk >= metrics.words) return 'chinese'
  return metrics.funcDensity >= threshold ? 'drift' : 'chinese'
}
