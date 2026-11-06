/**
 * Prompt layer for the in-page translator.
 *
 * Two-stage design, because "translate the page as a whole" and "be fast" pull in
 * opposite directions:
 *
 *  1. `contextPrompt` runs once per page (small input, small output) and decides
 *     what the page is *about*, so ambiguous words can be disambiguated before any
 *     sentence is translated. A film-photography community must render "film" as
 *     film-stock/胶片, not movie/电影.
 *  2. `translatePrompt` runs per chunk, but every chunk carries the page topic,
 *     tone and glossary from stage 1 — so chunk-level parallelism does not lose
 *     page-level context.
 *
 * Both prompts force a JSON reply keyed by the numeric segment id; the caller
 * extracts the object even when the model wraps it in prose or a code fence.
 */

/** Languages this plugin can render names for. */
export const LANGUAGES = Object.freeze({
  zh: '简体中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  ru: 'Русский',
})

/** Resolve the human name of a target language tag. */
export function languageName(target) {
  return LANGUAGES[target] ?? LANGUAGES.zh
}

/** Snippet length sent to the context stage; keeps that call small and quick. */
export const CONTEXT_SAMPLE_CHARS = 1400
/** Headings forwarded to the context stage. */
export const CONTEXT_MAX_HEADINGS = 12
/** Maximum glossary entries kept from the context stage. */
export const MAX_GLOSSARY = 16

/**
 * Build the page-context analysis request.
 * @param {object} page - metadata collected by the in-page script.
 * @param {string} page.url - final URL of the page.
 * @param {string} [page.title] - document title.
 * @param {string} [page.lang] - html lang attribute.
 * @param {object} [page.meta] - description / siteName / ogType / keywords.
 * @param {string[]} [page.headings] - h1..h3 texts.
 * @param {string} [page.sample] - first visible body text.
 * @param {string} target - target language tag.
 * @returns {{system: string, user: string}}
 */
export function contextPrompt(page, target = 'zh') {
  const language = languageName(target)
  const meta = page?.meta ?? {}
  const headings = (Array.isArray(page?.headings) ? page.headings : [])
    .map((heading) => String(heading ?? '').trim())
    .filter((heading) => heading !== '')
    .slice(0, CONTEXT_MAX_HEADINGS)
  const sample = String(page?.sample ?? '').replace(/\s+/g, ' ').trim().slice(0, CONTEXT_SAMPLE_CHARS)

  const system = [
    `你是网页翻译的前置分析器。你会看到某个网页的元数据与正文片段，请判断这个页面到底在讲什么，并给出把页面译成${language}时必须遵守的主题与术语约定。`,
    '只输出一个 JSON 对象，不要 markdown 围栏，不要解释。结构：',
    '{"topic":"一句话页面主题","domain":"领域，如 胶片摄影/前端开发/古典音乐","tone":"整体语气，如 技术说明/社区闲聊/营销","glossary":{"源词":"在本页语境下的译法"},"notes":"给译者的1-3条提醒"}',
    '硬性要求：',
    `1. 必须结合整体语境消除歧义，特别是领域多义词。示例：胶片摄影社区里 Film=胶片/胶卷（不是电影）；Thread=帖子（不是线）；Board=版块（不是木板）；Roll=胶卷（不是滚动）；Develop=冲洗（不是开发）；Print=照片/放大（不是打印）；Grain=颗粒（不是谷物）；Shutter=快门；Aperture=光圈。`,
    '2. glossary 只收录本页反复出现、易误译、或专有名词，最多 16 条；不要收录普通词。',
    '3. 没有把握的推断不要写进 glossary，宁缺毋滥。',
    '4. topic、domain、tone、notes 用中文。',
  ].join('\n')

  const user = [
    `页面 URL：${String(page?.url ?? '')}`,
    `页面标题：${String(page?.title ?? '')}`,
    `html lang：${String(page?.lang ?? '')}`,
    meta.description ? `meta description：${String(meta.description)}` : '',
    meta.siteName ? `站点名称：${String(meta.siteName)}` : '',
    meta.ogType ? `og:type：${String(meta.ogType)}` : '',
    meta.keywords ? `meta keywords：${String(meta.keywords)}` : '',
    headings.length > 0 ? `页面主要标题：\n${headings.map((heading) => `- ${heading}`).join('\n')}` : '',
    sample !== '' ? `正文开头片段：\n${sample}` : '',
  ]
    .filter((line) => line !== '')
    .join('\n')

  return { system, user }
}

/**
 * Build one chunk translation request.
 * @param {object} options - chunk payload.
 * @param {{topic?: string, domain?: string, tone?: string, glossary?: Record<string, string>, notes?: string} | null} options.context - page context from stage 1.
 * @param {Array<{id: string, text: string}>} options.segments - numbered segments of this chunk.
 * @param {string} options.target - target language tag.
 * @param {string} [options.pageUrl] - page URL, shown to the model for grounding.
 * @returns {{system: string, user: string}}
 */
export function translatePrompt({ context, segments, target = 'zh', pageUrl = '' }) {
  const language = languageName(target)
  const topic = context?.topic ?? ''
  const domain = context?.domain ?? ''
  const tone = context?.tone ?? ''
  const glossary = context?.glossary && typeof context.glossary === 'object' ? context.glossary : {}
  const glossaryLines = Object.entries(glossary)
    .filter(([source, translated]) => source !== '' && typeof translated === 'string' && translated !== '')
    .slice(0, MAX_GLOSSARY)
    .map(([source, translated]) => `${source} => ${translated}`)

  const system = [
    `你是专业网页翻译引擎，正在翻译一个${domain !== '' ? domain : '网页'}主题的页面${topic !== '' ? `（页面主题：${topic}）` : ''}。把用户给出的每一行原文译成${language}。`,
    tone !== '' ? `页面整体语气：${tone}。译文要保持这种语气与信息密度。` : '',
    '规则（必须全部遵守）：',
    '1. 只输出一个 JSON 对象：{"编号":"译文"}。键是每行行首方括号里的编号，原样照抄（字符串）。',
    '2. 逐行一一对应：给了 N 行就必须回 N 个键，不许合并、拆分、增删、漏行。',
    '3. 必须结合页面主题翻译，不要逐字硬译；同一个词在全页保持同一译法。',
    glossaryLines.length > 0 ? `4. 术语表优先，必须遵守：\n${glossaryLines.map((line) => `   - ${line}`).join('\n')}` : '4. 专有名词、品牌名、代码、变量名、URL、邮箱、数字与单位保持原样。',
    '5. 已经是目标语言的行原样返回，不要改写。',
    '6. 行内如果有 HTML 标签或占位符（如 {name}、%s），原样保留其位置。',
    '7. 不要解释、不要加前后缀文字、不要用 markdown 代码围栏。',
    context?.notes ? `8. 译者提醒：${context.notes}` : '',
  ]
    .filter((line) => line !== '')
    .join('\n')

  const user = [
    pageUrl !== '' ? `页面：${pageUrl}` : '',
    (Array.isArray(segments) ? segments : [])
      .map((segment) => `[${segment.id}] ${String(segment.text ?? '').replace(/\s+/g, ' ').trim()}`)
      .join('\n'),
  ]
    .filter((line) => line !== '')
    .join('\n')

  return { system, user }
}

/**
 * Reply tone presets shown in the pill's tone selector. The key is the value
 * stored in the page control; the text is the instruction sent to the model.
 */
export const TONES = Object.freeze({
  natural: '自然、符合该社区日常讨论的语气；像普通网友发评论，不要书面翻译腔。',
  casual: '随意、口语化；可以用常见的英文缩写和俚语（但不低俗）。',
  humorous: '保留并强化原文的幽默/玩笑感；允许轻微夸张和俏皮话。',
  technical: '偏专业、具体；使用该领域准确的英文术语，少用网络俚语。',
})

/**
 * Resolve a tone preset id to its instruction.
 * @param {string} [tone]
 * @returns {string}
 */
export function toneInstruction(tone) {
  return TONES[tone] ?? TONES.natural
}

/** Few-shot hints for Chinese internet/community idioms; the model should adapt them, not copy blindly. */
const SLANG_HINTS = [
  '报恩（器材/镜头）→ has been good to me / pays off / a keeper',
  '报仇（器材）→ fights me / is out to get me',
  '不要修理它（器材/作品）→ don\'t fix what isn\'t broken / don\'t mess with it',
  '种草 → makes me want one；拔草 → finally pulled the trigger',
  '真香 → I was wrong, it\'s actually great',
  '上头 → addictive；入坑 → got into it',
  '出片 → produces great shots；刀锐奶化 → razor-sharp with creamy bokeh',
  '一镜走天下 → one lens for everything；老法师 → old-school gear guru',
]

/**
 * Build the "reply composer" request: the user writes Chinese in the page pill
 * and wants a natural English reply for the community they are reading
 * (Reddit, Hacker News, a forum). Page context supplies the topic, tone and
 * glossary so the reply fits the thread instead of reading like machine output.
 * @param {object} options
 * @param {object | null} options.context - page context (topic/domain/tone/glossary).
 * @param {string} options.text - the user's Chinese draft.
 * @param {string} [options.pageUrl] - page URL, shown for grounding.
 * @param {string} [options.pageTitle] - page title, shown for grounding.
 * @param {string} [options.target] - target language tag (default `en`).
 * @param {string} [options.tone] - tone preset id (`natural`/`casual`/`humorous`/`technical`).
 * @returns {{system: string, user: string}}
 */
export function compositionPrompt({ context, text, pageUrl = '', pageTitle = '', target = 'en', tone = 'natural' }) {
  const language = languageName(target)
  const topic = context?.topic ?? ''
  const domain = context?.domain ?? ''
  const pageTone = context?.tone ?? ''
  const title = pageTitle !== '' ? pageTitle : (context?.title ?? '')
  const glossary = context?.glossary && typeof context.glossary === 'object' ? context.glossary : {}
  const glossaryLines = Object.entries(glossary)
    .filter(([source, translated]) => source !== '' && typeof translated === 'string' && translated !== '')
    .slice(0, MAX_GLOSSARY)
    .map(([source, translated]) => `${source} => ${translated}`)

  const system = [
    `你是一位英语社区的资深用户兼译者。用户写了一段中文，准备作为评论/回复发布到当前页面所在的英文社区（例如 Reddit、Hacker News、论坛）。`,
    `任务：把它写成让母语者觉得自然的${language}回复，而不是翻译腔。先理解整句话在社区语境里的真实意思（包括网络流行语、圈内梗、玩笑），再用英语社区里对等的说法表达；允许调整语序、省略、换比喻，只要原意不变。`,
    '硬性规则：',
    '1. 中文网络流行语/圈内梗不要逐字直译；若直译会让英文读者困惑，就换成最接近的英文惯用表达（可保留轻微幽默）。常用参考（按语境选择，不要生搬硬套）：',
    ...SLANG_HINTS.map((line) => `   - ${line}`),
    '2. 保留原意、信息量、幽默与礼貌程度；不要扩写、不要解释、不要加引号或任何前后缀，只输出译文。',
    '3. 译文要像英语母语者在社区里随手发的评论：句子可以短、可以用口语和态度词；不要把中文的比喻展开成解释性从句，宁可更短、更有态度。',
    '4. 专有名词、用户名、代码、URL、数字保持原样。',
    `5. 期望语气：${toneInstruction(tone)}`,
    pageTone !== '' ? `6. 页面整体语气：${pageTone}；回复要贴合这个帖子的氛围。` : '',
    title !== '' ? `页面标题：${title}` : '',
    topic !== '' ? `页面主题：${topic}` : '',
    domain !== '' ? `社区/领域：${domain}` : '',
    pageUrl !== '' ? `页面 URL：${pageUrl}` : '',
    glossaryLines.length > 0 ? `术语表（必须遵守）：\n${glossaryLines.map((line) => `- ${line}`).join('\n')}` : '',
  ]
    .filter((line) => line !== '')
    .join('\n')

  return { system, user: String(text ?? '') }
}

/**
 * Render a context object as a compact one-line summary for the UI badge.
 * @param {{topic?: string, domain?: string, glossary?: Record<string, string>} | null} context
 * @returns {string} empty string when there is nothing to show.
 */
export function describeContext(context) {
  if (!context || typeof context !== 'object') return ''
  const parts = []
  if (context.topic) parts.push(String(context.topic))
  const glossary = context.glossary && typeof context.glossary === 'object' ? context.glossary : {}
  const examples = Object.entries(glossary).slice(0, 3)
  if (examples.length > 0) parts.push(examples.map(([source, translated]) => `${source}→${translated}`).join('，'))
  return parts.join(' · ')
}
