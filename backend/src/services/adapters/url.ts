export function joinProviderUrl(baseUrl: string, requiredPrefix: string, path: string) {
  const normalizedBase = (baseUrl || '').replace(/\/+$/, '')
  const normalizedPrefix = normalizeSegment(requiredPrefix)
  // path 可能自带查询串（?task_id=…），必须与 pathname 分开处理，
  // 否则 URL.pathname 会把 '?' 百分号编码成 %3F。
  const queryIndex = path.indexOf('?')
  const rawPath = queryIndex === -1 ? path : path.slice(0, queryIndex)
  const rawQuery = queryIndex === -1 ? '' : path.slice(queryIndex + 1)
  const normalizedPath = normalizeSegment(rawPath)

  if (!normalizedBase) {
    return `${normalizedPrefix}${normalizedPath}${rawQuery ? `?${rawQuery}` : ''}`
  }

  try {
    const url = new URL(normalizedBase)
    const currentPath = url.pathname.replace(/\/+$/, '')
    // 若已有路径以版本号段结尾（如 /v1、/v2），且目标前缀也是版本号段（如 /v2、/v1），
    // 则将已有版本号替换为目标版本号，避免产生 /v1/v2 或 /v2/v1 等冲突路径
    const versionPattern = /\/v\d+$/i
    let cleanPath = currentPath
    if (versionPattern.test(cleanPath) && versionPattern.test(normalizedPrefix)) {
      cleanPath = cleanPath.replace(versionPattern, '')
    }
    const mergedPrefix = cleanPath.endsWith(normalizedPrefix)
      ? cleanPath
      : `${cleanPath}${normalizedPrefix}`

    url.pathname = `${mergedPrefix}${normalizedPath}`.replace(/\/{2,}/g, '/')
    if (rawQuery) url.search = rawQuery
    return url.toString()
  } catch {
    const versionPattern = /\/v\d+$/i
    let cleanBase = normalizedBase
    if (versionPattern.test(cleanBase) && versionPattern.test(normalizedPrefix)) {
      cleanBase = cleanBase.replace(versionPattern, '')
    }
    const basePath = cleanBase.endsWith(normalizedPrefix)
      ? cleanBase
      : `${cleanBase}${normalizedPrefix}`
    return `${basePath}${normalizedPath}${rawQuery ? `?${rawQuery}` : ''}`
    return `${basePath}${normalizedPath}${rawQuery ? `?${rawQuery}` : ''}`
  }
}

function normalizeSegment(segment: string) {
  if (!segment) return ''
  return segment.startsWith('/') ? segment : `/${segment}`
}
