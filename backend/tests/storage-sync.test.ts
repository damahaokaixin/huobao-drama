import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  getRawStorageSyncConfig,
  getMaskedStorageSyncConfig,
  saveStorageSyncConfig,
  testStorageSyncConnection,
  type StorageSyncSettings,
} from '../src/services/storage-sync.js'
import { db, schema } from '../src/db/index.js'
import { eq } from 'drizzle-orm'

let originalRow: any = null

before(() => {
  originalRow = db.select().from(schema.appSettings)
    .where(eq(schema.appSettings.key, 'storage_sync_config'))
    .get()
})

after(() => {
  if (originalRow) {
    db.insert(schema.appSettings)
      .values(originalRow)
      .onConflictDoUpdate({
        target: schema.appSettings.key,
        set: originalRow,
      })
      .run()
  } else {
    db.delete(schema.appSettings)
      .where(eq(schema.appSettings.key, 'storage_sync_config'))
      .run()
  }
})

test('storage sync: saves config and masks secret access key for client output', () => {
  const input: StorageSyncSettings = {
    mode: 's3',
    s3: {
      endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
      region: 'cn-hangzhou',
      bucket: 'test-bucket',
      accessKeyId: 'test-ak',
      secretAccessKey: 'super-secret-key-12345',
      publicDomain: 'https://cdn.example.com',
      forcePathStyle: false,
      ssl: true,
    },
  }

  const saved = saveStorageSyncConfig(input)
  assert.equal(saved.mode, 's3')
  assert.equal(saved.s3?.bucket, 'test-bucket')
  assert.equal(saved.s3?.accessKeyId, 'test-ak')
  assert.equal(saved.s3?.secretAccessKey, '******', 'Secret key should be masked')
  assert.equal(saved.s3?.publicDomain, 'https://cdn.example.com')

  // 前端带 ****** 保存时，不应覆盖真实密码
  const updatedWithoutSecret = saveStorageSyncConfig({
    mode: 's3',
    s3: {
      ...saved.s3!,
      bucket: 'test-bucket-renamed',
    },
  })
  assert.equal(updatedWithoutSecret.s3?.bucket, 'test-bucket-renamed')
  assert.equal(updatedWithoutSecret.s3?.secretAccessKey, '******')
})

test('storage sync: web_server mode validates missing public URL', async () => {
  await assert.rejects(
    async () => {
      await testStorageSyncConnection({
        mode: 'web_server',
        publicBaseUrl: '',
      })
    },
    /未配置 Web 服务公网 URL/,
  )
})

test('storage sync: s3 mode validates missing bucket credentials', async () => {
  await assert.rejects(
    async () => {
      await testStorageSyncConnection({
        mode: 's3',
        s3: {
          endpoint: 'https://s3.amazonaws.com',
          region: 'us-east-1',
          bucket: '',
          accessKeyId: '',
          secretAccessKey: '',
        },
      })
    },
    /Bucket 不能为空/,
  )
})
