/**
 * MiniMax H3 全模态视频生成提示词编译器 (H3 Prompt Compiler)
 *
 * 遵循 MiniMax 官方 H3 视频生成提示词规范与工业级生产实践：
 * 1. 镜头对齐声明：<Picture 1> aligned at 0.00s / <Picture 2> aligned at 5.00s
 * 2. 多模态参考主体映射与正向采纳/负向排除：
 *    <Subject 1> (Environment): [Image 1] @场景名（空间布局、家具陈设与光线氛围，排除杂物）
 *    <Subject 2> (Character): [Image 2] @角色名（五官面容、发型妆造、体型姿态，排除背景）
 * 3. 分镜头标记标准化：[Shot 1] / [Shot 2] ...
 * 4. 原生对白音画口型同步：<d>[Chinese] 角色名: "台词内容" </d>
 * 5. 全局音效与底乐氛围：overall_soundscape: <环境音效 + 物理微动作音 + BGM 配器与节奏>
 * 6. 全片连续性与负向文本排除：全片保持无字幕，不生成任何文字、字幕、标题、标识或说明性文本
 * 7. 兼容性：将用户/前端习惯的 @角色名、@图片N 自动转译为官方 [Image N] 标记
 */

export interface H3PromptContext {
  prompt: string
  duration?: number
  hasFirstFrame?: boolean
  hasLastFrame?: boolean
  referenceImageCount?: number
  referenceNames?: string[] // 每个参考图对应的实体名称（如 ['小明', '办公室']）
  soundEffect?: string
  atmosphere?: string
  bgmPrompt?: string
}

const H3_MAX_CHARS = 7000

/**
 * 编译转译提示词为 MiniMax H3 官方规范
 */
export function compileH3Prompt(ctx: H3PromptContext): string {
  let raw = (ctx.prompt || '').trim()
  if (!raw) return ''

  // 收集头部声明行
  const headerLines: string[] = []

  // 1. 首尾帧对齐声明
  if (ctx.hasFirstFrame && !raw.includes('<Picture 1>')) {
    headerLines.push('<Picture 1> aligned at 0.00s')
  }
  if (ctx.hasLastFrame && !raw.includes('<Picture 2>')) {
    const dur = (ctx.duration && ctx.duration > 0 ? ctx.duration : 5).toFixed(2)
    headerLines.push(`<Picture 2> aligned at ${dur}s`)
  }

  // 2. 映射参考图主体（Subject Declarations）
  const refCount = Math.min(ctx.referenceImageCount || 0, 9)
  const names = ctx.referenceNames || []

  // 建立 实体名 -> [Image N] 映射表
  const nameToImageTag = new Map<string, string>()
  const nameToSubjectTag = new Map<string, string>()

  for (let i = 0; i < refCount; i++) {
    const imgIndex = i + 1
    const imgTag = `[Image ${imgIndex}]`
    const subTag = `<Subject ${imgIndex}>`
    const name = names[i] ? names[i].trim() : ''

    if (name) {
      nameToImageTag.set(name, imgTag)
      nameToSubjectTag.set(name, subTag)
    }

    // 若未书写主体声明，在头部自动生成规范声明
    if (!raw.includes(`<Subject ${imgIndex}>`) && !raw.includes(imgTag)) {
      const label = name ? `${name}` : `参考主体 ${imgIndex}`
      headerLines.push(`<Subject ${imgIndex}> (Character): ${imgTag} ${label}`)
    }
  }

  // 3. 转译 @角色名 或 @图片N名字 为 [Image N]
  // 处理阿里 Wanx 格式：@图片1小明 → [Image 1] 小明
  raw = raw.replace(/@图片(\d+)([^\s@，。！？,.!?\n]*)/g, (_m, num, rest) => {
    return `[Image ${num}]${rest ? ` ${rest}` : ''}`
  })

  // 处理通用 @角色名 → [Image N] 角色名
  if (nameToImageTag.size > 0) {
    // 按名称长度降序匹配，防止前缀冲突
    const sortedNames = Array.from(nameToImageTag.keys()).sort((a, b) => b.length - a.length)
    for (const name of sortedNames) {
      const imgTag = nameToImageTag.get(name)!
      const regex = new RegExp(`@${escapeRegex(name)}`, 'g')
      raw = raw.replace(regex, `${imgTag} ${name}`)
    }
  }

  // 4. 标准化分镜头标记：将 【镜头1】、镜头 1、Shot 1 统一转为 [Shot 1]
  raw = raw.replace(/【镜头\s*(\d+)】/g, '[Shot $1]')
  raw = raw.replace(/(?:^|\n)\s*镜头\s*(\d+)[:：]?\s*/g, '\n[Shot $1]\n')
  raw = raw.replace(/(?:^|\n)\s*Shot\s*(\d+)[:：]?\s*/gi, '\n[Shot $1]\n')

  // 5. 对白/口播台词转译为 MiniMax H3 原生音画口型同步语法：<d>[Chinese] 角色: "台词" </d>
  if (!raw.includes('<d>')) {
    // 优先匹配常规 对白：xxx 或 台词：xxx
    raw = raw.replace(/(?:^|\n)\s*(?:对白|台词)[:：]\s*["“]?([^"”\n\r]+)["”]?/g, (_m, line) => {
      const cleanLine = line.trim()
      if (!cleanLine) return ''
      const speaker = names[0] || '角色'
      return `\n<d>[Chinese] ${speaker}: "${cleanLine}" </d>`
    })

    // 匹配 [角色名] 台词内容 或 [达人旁白] 台词内容
    raw = raw.replace(/(?:^|\n)\s*\[([^\]]+)\]\s*[:：]?\s*["“]?([^"”\r\n]+)["”]?/g, (m, speaker, line) => {
      if (/^Shot\s*\d+/i.test(speaker) || /^Image\s*\d+/i.test(speaker) || /^Subject\s*\d+/i.test(speaker)) return m
      const cleanLine = line.trim()
      if (!cleanLine) return m
      return `\n<d>[Chinese] ${speaker.trim()}: "${cleanLine}" </d>`
    })

    // 匹配 声音：达人旁白（语气说明）：台词
    raw = raw.replace(/(?:^|\n)\s*(?:声音[:：]\s*)?([^\s:：\n\r"“”<>[\]()（）]+)(?:[(（][^()（）]*[)）])?[:：]\s*["“]?([^"”\r\n]+)["”]?/g, (m, speaker, line) => {
      if (/^(Shot|Picture|Subject|overall_soundscape|镜头|画面|时间|拍法|风格|场景|主体|产品|道具|比例|标题|视觉|打光|剪辑|色彩|对白|台词)/i.test(speaker)) return m
      const cleanLine = line.trim()
      if (!cleanLine || cleanLine.length < 2) return m
      return `\n<d>[Chinese] ${speaker.trim()}: "${cleanLine}" </d>`
    })
  }

  // 6. 环境物理音效与 BGM 底乐（overall_soundscape）
  const soundParts: string[] = []
  if (ctx.soundEffect && ctx.soundEffect.trim()) soundParts.push(ctx.soundEffect.trim())
  if (ctx.atmosphere && ctx.atmosphere.trim()) soundParts.push(ctx.atmosphere.trim())
  if (ctx.bgmPrompt && ctx.bgmPrompt.trim()) soundParts.push(`BGM: ${ctx.bgmPrompt.trim()}`)

  // 检查正文中是否含有全片 BGM 描述
  const bgmMatch = raw.match(/(?:^|\n)\s*(?:全片\s*BGM|BGM)[:：]\s*([^\n\r]+)/i)
  if (bgmMatch && bgmMatch[1]) {
    soundParts.push(`BGM: ${bgmMatch[1].trim()}`)
  }

  let soundscapeBlock = ''
  if (soundParts.length > 0 && !raw.includes('overall_soundscape:')) {
    soundscapeBlock = `overall_soundscape: ${soundParts.join('，')}`
  }

  // 7. 负向纯净度与无字幕硬约束（商业视频关键防乱码铁律）
  const negativeConstraint = '全片保持主体、产品与场景连续一致；全片保持无字幕，不生成任何文字、字幕、标题、标识或说明性文本。'
  let trailingConstraint = ''
  if (!raw.includes('无字幕') && !raw.includes('不生成任何文字')) {
    trailingConstraint = negativeConstraint
  }

  // 8. 组合最终 Prompt
  const finalSections: string[] = []
  if (headerLines.length > 0) {
    finalSections.push(headerLines.join('\n'))
  }
  if (raw) {
    finalSections.push(raw)
  }
  if (soundscapeBlock) {
    finalSections.push(soundscapeBlock)
  }
  if (trailingConstraint) {
    finalSections.push(trailingConstraint)
  }

  let compiled = finalSections.join('\n\n').trim()

  // 9. 长度安全钳制
  if (compiled.length > H3_MAX_CHARS) {
    compiled = compiled.slice(0, H3_MAX_CHARS).trim()
    // 若截断了未闭合的 </d>，补充闭合
    const openD = (compiled.match(/<d>/g) || []).length
    const closeD = (compiled.match(/<\/d>/g) || []).length
    if (openD > closeD) {
      compiled += ' </d>'
    }
  }

  return compiled
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
