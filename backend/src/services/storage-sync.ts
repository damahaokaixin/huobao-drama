/**
 * 资产存储与公网同步服务
 *
 * 解决 MiniMax 等大模型生成视频时必须通过公网 URL 访问本地参考素材的问题。
 * 支持两种模式：
 * 1. Web 服务反代域名模式（web_server）：通过配置的公网 Base URL 访问本地 static 文件
 * 2. 对象存储同步模式（s3）：兼容 AWS S3、阿里云 OSS、腾讯云 COS、MinIO 等标准 S3 协议
 *    - 素材落盘即时双写上传到存储桶
 *    - 分镜/素材删除时级联删除本地磁盘与云端存储对象
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getAbsolutePath, thumbPathFor } from '../utils/storage.js'
import { ProviderError } from './adapters/errors.js'

export type StorageSyncMode = 'disabled' | 'web_server' | 's3'

export interface S3Config {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  publicDomain?: string
  forcePathStyle?: boolean
  ssl?: boolean
}

export interface StorageSyncSettings {
  mode: StorageSyncMode
  publicBaseUrl?: string
  s3?: S3Config
}

const SETTINGS_KEY = 'storage_sync_config'
const MASKED_SECRET = '******'

// 内存中缓存已上传的本地路径 -> 公网 S3 URL，避免单次任务重复上传
const uploadCache = new Map<string, string>()

let cachedClient: { client: S3Client; key: string } | null = null
let lastUploadError: string | null = null

/**
 * 获取存储同步配置（未脱敏，内部使用）
 */
export function getRawStorageSyncConfig(): StorageSyncSettings {
  const row = db.select().from(schema.appSettings)
    .where(eq(schema.appSettings.key, SETTINGS_KEY))
    .get()

  if (row?.value) {
    try {
      const parsed = JSON.parse(row.value) as StorageSyncSettings
      return parsed
    } catch {
      // 解析失败回退
    }
  }

  // 默认回退读取 process.env.PUBLIC_BASE_URL
  const envBaseUrl = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '')
  if (envBaseUrl) {
    return {
      mode: 'web_server',
      publicBaseUrl: envBaseUrl,
    }
  }

  return {
    mode: 'disabled',
    publicBaseUrl: '',
  }
}

/**
 * 获取对外脱敏后的存储同步配置（用于前端展示）
 */
export function getMaskedStorageSyncConfig(): StorageSyncSettings {
  const cfg = getRawStorageSyncConfig()
  const copy: StorageSyncSettings = JSON.parse(JSON.stringify(cfg))
  if (copy.s3?.secretAccessKey) {
    copy.s3.secretAccessKey = MASKED_SECRET
  }
  return copy
}

/**
 * 保存存储同步配置
 */
export function saveStorageSyncConfig(input: Partial<StorageSyncSettings>): StorageSyncSettings {
  const existing = getRawStorageSyncConfig()

  const mode: StorageSyncMode = (['disabled', 'web_server', 's3'].includes(input.mode || ''))
    ? (input.mode as StorageSyncMode)
    : 'disabled'

  const publicBaseUrl = (input.publicBaseUrl || '').trim().replace(/\/+$/, '')

  let s3: S3Config | undefined
  if (input.s3) {
    let secret = (input.s3.secretAccessKey || '').trim()
    // 若前端回传脱敏占位符，保留原有真实 secret
    if (secret === MASKED_SECRET || secret.includes('***')) {
      secret = existing.s3?.secretAccessKey || ''
    }

    s3 = {
      endpoint: (input.s3.endpoint || '').trim().replace(/\/+$/, ''),
      region: (input.s3.region || 'auto').trim(),
      bucket: (input.s3.bucket || '').trim(),
      accessKeyId: (input.s3.accessKeyId || '').trim(),
      secretAccessKey: secret,
      publicDomain: (input.s3.publicDomain || '').trim().replace(/\/+$/, ''),
      forcePathStyle: Boolean(input.s3.forcePathStyle),
      ssl: input.s3.ssl !== false,
    }
  } else if (existing.s3) {
    s3 = existing.s3
  }

  const updated: StorageSyncSettings = {
    mode,
    publicBaseUrl,
    s3,
  }

  db.insert(schema.appSettings)
    .values({ key: SETTINGS_KEY, value: JSON.stringify(updated), updatedAt: now() })
    .onConflictDoUpdate({
      target: schema.appSettings.key,
      set: { value: JSON.stringify(updated), updatedAt: now() },
    })
    .run()

  // 释放 client 缓存
  cachedClient = null
  uploadCache.clear()

  return getMaskedStorageSyncConfig()
}

/**
 * 创建或获取 S3Client 实例
 */
export function getS3Client(s3Cfg?: S3Config): S3Client | null {
  const cfg = s3Cfg || getRawStorageSyncConfig().s3
  if (!cfg || !cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey) {
    return null
  }

  let endpoint = cfg.endpoint
  if (endpoint && !endpoint.startsWith('http://') && !endpoint.startsWith('https://')) {
    endpoint = `${cfg.ssl !== false ? 'https' : 'http'}://${endpoint}`
  }

  const clientKey = `${endpoint}|${cfg.region}|${cfg.bucket}|${cfg.accessKeyId}|${cfg.forcePathStyle}`
  if (cachedClient && cachedClient.key === clientKey) {
    return cachedClient.client
  }

  const client = new S3Client({
    endpoint: endpoint || undefined,
    region: cfg.region || 'auto',
    forcePathStyle: cfg.forcePathStyle ?? false,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  })

  cachedClient = { client, key: clientKey }
  return client
}

/**
 * 测试存储连接通畅性
 */
export async function testStorageSyncConnection(inputConfig?: StorageSyncSettings): Promise<{
  success: boolean
  message: string
  details?: Record<string, any>
}> {
  const cfg = inputConfig || getRawStorageSyncConfig()

  if (cfg.mode === 'disabled') {
    return {
      success: true,
      message: '当前未启用外部资产存储同步（仅使用本地存储）',
    }
  }

  if (cfg.mode === 'web_server') {
    const url = (cfg.publicBaseUrl || '').trim()
    if (!url) {
      throw new Error('未配置 Web 服务公网 URL')
    }
    const startTime = Date.now()
    try {
      const resp = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(10_000),
      })
      const durationMs = Date.now() - startTime
      return {
        success: true,
        message: `Web 服务公网探测通畅（HTTP ${resp.status}，耗时 ${durationMs}ms）`,
        details: { url, httpStatus: resp.status, durationMs },
      }
    } catch (e: any) {
      throw new Error(`Web 服务公网探测失败: ${e.message || String(e)}`)
    }
  }

  if (cfg.mode === 's3') {
    const s3 = cfg.s3
    if (!s3) throw new Error('未配置对象存储参数')
    if (!s3.bucket) throw new Error('Bucket 不能为空')
    if (!s3.accessKeyId) throw new Error('AccessKeyId 不能为空')

    let secret = s3.secretAccessKey
    if (secret === MASKED_SECRET || secret.includes('***')) {
      secret = getRawStorageSyncConfig().s3?.secretAccessKey || ''
    }
    if (!secret) throw new Error('SecretAccessKey 不能为空')

    const client = getS3Client({ ...s3, secretAccessKey: secret })
    if (!client) throw new Error('初始化 S3Client 失败')

    const testKey = `.huobao-probe-test-${Date.now()}.txt`
    const startTime = Date.now()

    try {
      // 1. 上传测试探测文件
      await client.send(
        new PutObjectCommand({
          Bucket: s3.bucket,
          Key: testKey,
          Body: Buffer.from(`huobao probe test at ${new Date().toISOString()}`),
          ContentType: 'text/plain',
        }),
      )

      // 2. 删除测试探测文件
      await client.send(
        new DeleteObjectCommand({
          Bucket: s3.bucket,
          Key: testKey,
        }),
      )

      const durationMs = Date.now() - startTime
      return {
        success: true,
        message: `对象存储连通性正常（已验证 Bucket 读写与清理权限，耗时 ${durationMs}ms）`,
        details: {
          bucket: s3.bucket,
          region: s3.region,
          durationMs,
        },
      }
    } catch (e: any) {
      throw new Error(`对象存储探测失败: ${e.message || String(e)}`)
    }
  }

  return { success: false, message: '未知存储模式' }
}

/**
 * 组装对象在 S3 中的访问公网 URL
 */
function buildS3PublicUrl(s3: S3Config, key: string): string {
  if (s3.publicDomain) {
    const base = s3.publicDomain.trim().replace(/\/+$/, '')
    return `${base}/${key.replace(/^\/+/, '')}`
  }

  let endpoint = s3.endpoint.trim().replace(/\/+$/, '')
  const proto = s3.ssl !== false ? 'https://' : 'http://'
  let endpointNoProto = endpoint.replace(/^https?:\/\//, '')

  if (s3.forcePathStyle) {
    return `${proto}${endpointNoProto}/${s3.bucket}/${key.replace(/^\/+/, '')}`
  }

  // 虚拟主机风格：如果 endpoint 本身已经带了 bucket 前缀（例如 bucket.oss-cn-hangzhou.aliyuncs.com），则去除避免重复
  const bucketPrefix = `${s3.bucket}.`
  if (endpointNoProto.startsWith(bucketPrefix)) {
    endpointNoProto = endpointNoProto.slice(bucketPrefix.length)
  }

  return `${proto}${s3.bucket}.${endpointNoProto}/${key.replace(/^\/+/, '')}`
}

/**
 * 将本地相对路径或绝对路径解析为统一的 S3 Key
 */
function toS3Key(localRelativeOrAbsPath: string): string {
  const norm = localRelativeOrAbsPath.replace(/\\/g, '/')
  const staticIdx = norm.indexOf('static/')
  if (staticIdx !== -1) {
    return norm.slice(staticIdx)
  }
  return `static/${path.basename(norm)}`
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.json': 'application/json',
  }
  return map[ext] || 'application/octet-stream'
}

/**
 * 将单个资产文件即时上传至配置的对象存储（双写同步）
 * @param localPath 本地相对路径（如 'static/images/xxx.png'）或绝对路径
 * @returns 云端公网直链 URL，未开启 S3 或失败则返回 null
 */
export async function uploadAssetToStorage(localPath: string): Promise<string | null> {
  const cfg = getRawStorageSyncConfig()
  if (cfg.mode !== 's3' || !cfg.s3) return null

  const s3 = cfg.s3
  const client = getS3Client(s3)
  if (!client) return null

  const absPath = localPath.startsWith('/') ? localPath : getAbsolutePath(localPath)
  if (!fs.existsSync(absPath)) return null

  const key = toS3Key(localPath)
  const cached = uploadCache.get(key)
  if (cached) return cached

  try {
    const fileBuffer = await fs.promises.readFile(absPath)
    const contentType = getMimeType(absPath)

    await client.send(
      new PutObjectCommand({
        Bucket: s3.bucket,
        Key: key,
        Body: fileBuffer,
        ContentType: contentType,
      }),
    )

    const publicUrl = buildS3PublicUrl(s3, key)
    uploadCache.set(key, publicUrl)
    lastUploadError = null

    // 伴随上传缩略图（若存在）
    const thumbRel = thumbPathFor(localPath)
    const thumbAbs = getAbsolutePath(thumbRel)
    if (fs.existsSync(thumbAbs)) {
      const thumbKey = toS3Key(thumbRel)
      const thumbBuffer = await fs.promises.readFile(thumbAbs)
      await client.send(
        new PutObjectCommand({
          Bucket: s3.bucket,
          Key: thumbKey,
          Body: thumbBuffer,
          ContentType: 'image/webp',
        }),
      ).catch(() => {})
    }

    return publicUrl
  } catch (err: any) {
    lastUploadError = err?.message || String(err)
    console.error(`[storage-sync] 上传资产到 S3 失败 (${localPath}):`, lastUploadError)
    return null
  }
}

/**
 * 从对象存储中删除素材对象（级联清理）
 */
export async function deleteAssetFromStorage(urlOrPath: string): Promise<boolean> {
  const cfg = getRawStorageSyncConfig()
  if (cfg.mode !== 's3' || !cfg.s3) return false

  const s3 = cfg.s3
  const client = getS3Client(s3)
  if (!client) return false

  const key = toS3Key(urlOrPath)
  try {
    await client.send(
      new DeleteObjectCommand({
        Bucket: s3.bucket,
        Key: key,
      }),
    )
    uploadCache.delete(key)

    // 伴随删除缩略图
    const thumbKey = thumbPathFor(key)
    await client.send(
      new DeleteObjectCommand({
        Bucket: s3.bucket,
        Key: thumbKey,
      }),
    ).catch(() => {})

    return true
  } catch (err: any) {
    console.warn(`[storage-sync] 从 S3 删除资产失败 (${urlOrPath}):`, err?.message || err)
    return false
  }
}

/**
 * 级联物理清理资产（同时清理本地磁盘与云端存储）
 */
export async function deleteAssetFiles(pathsOrUrls: (string | null | undefined)[]): Promise<void> {
  const items = Array.from(new Set(pathsOrUrls.map((p) => String(p || '').trim()).filter(Boolean)))
  for (const item of items) {
    // 1. 云端清理
    await deleteAssetFromStorage(item).catch(() => {})

    // 2. 本地磁盘清理
    if (item.startsWith('static/') || item.startsWith('/static/')) {
      const absPath = getAbsolutePath(item)
      try {
        if (fs.existsSync(absPath)) {
          await fs.promises.unlink(absPath)
        }
        const thumbAbs = getAbsolutePath(thumbPathFor(item))
        if (fs.existsSync(thumbAbs)) {
          await fs.promises.unlink(thumbAbs)
        }
      } catch (err: any) {
        console.warn(`[storage-sync] 删除本地文件失败 (${absPath}):`, err?.message || err)
      }
    }
  }
}

/**
 * 将本地素材或远程素材解析为大模型可访问的公网 URL。
 * - http(s) 直通；
 * - 本地 static 路径优先通过已配置的 S3 同步上传并返回直链；
 * - 若未启用 S3，则尝试通过 PUBLIC_BASE_URL 拼成 Web 服务公网地址；
 * - 未配置任何外部访问时抛出包含操作建议的 ProviderError。
 */
export async function resolvePublicAssetUrl(
  value: string | null | undefined,
  kind: 'video' | 'audio' | 'file' | 'image',
): Promise<string | null> {
  const raw = String(value || '').trim()
  if (!raw) return null

  // 已经是公网 URL 或 dataURL
  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('data:')) {
    // 排除 localhost / 127.0.0.1 伪公网 URL（大模型无法拉取本地回环）
    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(raw)
    if (!isLocalhost) return raw
  }

  const isStatic = raw.startsWith('static/') || raw.startsWith('/static/')
  const cleanPath = raw.startsWith('/') ? raw.slice(1) : raw

  const cfg = getRawStorageSyncConfig()

  // 1. 若开启了 S3 模式，即时上传到 S3 并返回云端公网直链
  if (cfg.mode === 's3' && cfg.s3) {
    const s3Url = await uploadAssetToStorage(cleanPath)
    if (s3Url) return s3Url
    if (lastUploadError) {
      throw new ProviderError({
        stage: 'config',
        message: `本地参考素材 ${raw} 上传到对象存储失败: ${lastUploadError}`,
        hint: '请前往「设置 - Web 服务与云存储」检查您的 Bucket 名称、Endpoint、AccessKey 及权限是否正确',
      })
    }
  }

  // 2. 若开启了 Web 服务公网域名模式（或环境变量设置了 PUBLIC_BASE_URL）
  const base = (cfg.publicBaseUrl || process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '')
  if (base && isStatic) {
    return `${base}/${cleanPath}`
  }

  // 3. 未配置外部访问能力
  const label = kind === 'video' ? '视频' : kind === 'audio' ? '音频' : kind === 'image' ? '图片' : '文件'
  throw new ProviderError({
    stage: 'config',
    message: `参考${label}为本地路径 ${raw}，但系统尚未配置对象存储（S3/OSS/COS）或公网 Web 服务访问域名，大模型无法访问您的本地文件。`,
    hint: '请前往「设置」页面配置「资产存储与 Web 服务」（支持配置阿里云 OSS / 腾讯云 COS / S3，或填写公网反代域名）',
  })
}

/**
 * 批量解析公网素材 URL
 */
export async function resolvePublicAssetUrls(
  refs: string[] | null | undefined,
  kind: 'video' | 'audio' | 'image',
): Promise<string[]> {
  if (!Array.isArray(refs) || !refs.length) return []
  const items = Array.from(new Set(refs.map((item) => String(item || '').trim()).filter(Boolean)))
  const resolved = await Promise.all(items.map((item) => resolvePublicAssetUrl(item, kind)))
  return resolved.filter((item): item is string => !!item)
}
