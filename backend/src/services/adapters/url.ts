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
    const mergedPrefix = currentPath.endsWith(normalizedPrefix)
      ? currentPath
      : `${currentPath}${normalizedPrefix}`

    url.pathname = `${mergedPrefix}${normalizedPath}`.replace(/\/{2,}/g, '/')
    if (rawQuery) url.search = rawQuery
    return url.toString()
  } catch {
    const basePath = normalizedBase.endsWith(normalizedPrefix)
      ? normalizedBase
      : `${normalizedBase}${normalizedPrefix}`
    return `${basePath}${normalizedPath}${rawQuery ? `?${rawQuery}` : ''}`
  }
}

function normalizeSegment(segment: string) {
  if (!segment) return ''
  return segment.startsWith('/') ? segment : `/${segment}`
}
