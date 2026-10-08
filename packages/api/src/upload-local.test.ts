import { afterAll, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const base = vi.hoisted(
  () => `${process.env.TEMP || process.env.TMPDIR || '/tmp'}/shumai-local-route-${process.pid}`,
)

vi.mock('@shumai/core/src/s3/s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shumai/core/src/s3/s3')>()
  return {
    ...actual,
    s3Service: new actual.LocalStorageService('http://localhost:3000', base),
  }
})

import { localUploadRoute, parseCompleteMultipartBody } from './upload'
import { s3Service } from '@shumai/core/src/s3/s3'

const app = localUploadRoute

// The route is mounted under /api in the app; here it is mounted at the root.
const routePath = (u: URL) => `${u.pathname.replace('/api', '')}${u.search}`

// Presign through the real service and call the route with the path + query it produced.
async function call(method: 'PUT' | 'POST' | 'GET' | 'DELETE', mp: object, body?: string | Buffer) {
  const { url } = await s3Service.presignMultipart('bkt', 'obj.bin', {
    key: 'obj.bin',
    method,
    fileId: 'f',
    ...mp,
  })
  const u = new URL(url)
  return app.request(`${routePath(u)}`, { method, body: body as BodyInit | undefined })
}

describe('local multipart upload route', () => {
  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  it('runs create, part uploads, list and complete end to end', async () => {
    const created = await (await call('POST', {})).text()
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(created)![1]

    const etags: Record<number, string> = {}
    for (const [n, text] of [
      [2, 'world'],
      [1, 'hello '],
    ] as const) {
      const res = await call('PUT', { uploadId, partNumber: n }, text)
      expect(res.status).toBe(200)
      etags[n] = res.headers.get('ETag')!
      expect(etags[n]).toBeTruthy()
    }

    const listed = await (await call('GET', { uploadId })).text()
    expect(listed).toContain('<PartNumber>1</PartNumber>')
    expect(listed).toContain('<Size>6</Size>')

    const xml = `<CompleteMultipartUpload>${[1, 2]
      .map(
        (n) =>
          `<Part><PartNumber>${n}</PartNumber><ETag>${etags[n].replace(/"/g, '&quot;')}</ETag></Part>`,
      )
      .join('')}</CompleteMultipartUpload>`
    const done = await call('POST', { uploadId }, xml)
    expect(done.status).toBe(200)
    expect(fs.readFileSync(path.join(base, 'bkt', 'obj.bin'), 'utf8')).toBe('hello world')
  })

  it('aborts an upload with DELETE', async () => {
    const created = await (await call('POST', {})).text()
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(created)![1]
    await call('PUT', { uploadId, partNumber: 1 }, 'x')
    expect((await call('DELETE', { uploadId })).status).toBe(204)
    expect((await call('GET', { uploadId })).status).toBe(404)
  })

  it('rejects a tampered part number with 403', async () => {
    const created = await (await call('POST', {})).text()
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(created)![1]
    const { url } = await s3Service.presignMultipart('bkt', 'obj.bin', {
      key: 'obj.bin',
      method: 'PUT',
      fileId: 'f',
      uploadId,
      partNumber: 1,
    })
    const u = new URL(url)
    u.searchParams.set('partNumber', '2')
    const res = await app.request(`${routePath(u)}`, { method: 'PUT', body: 'x' })
    expect(res.status).toBe(403)
  })

  it('still accepts the legacy whole-object PUT', async () => {
    const { url } = await s3Service.presignMultipart('bkt', 'whole.txt', {
      key: 'whole.txt',
      method: 'PUT',
      fileId: 'f',
    })
    const u = new URL(url)
    const res = await app.request(`${routePath(u)}`, { method: 'PUT', body: 'single' })
    expect(res.status).toBe(200)
    expect(fs.readFileSync(path.join(base, 'bkt', 'whole.txt'), 'utf8')).toBe('single')
  })

  it('parses the part list from a CompleteMultipartUpload body', () => {
    expect(
      parseCompleteMultipartBody(
        '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>&quot;a&quot;</ETag></Part><Part><PartNumber>2</PartNumber></Part></CompleteMultipartUpload>',
      ),
    ).toEqual([
      { partNumber: 1, etag: '"a"' },
      { partNumber: 2, etag: undefined },
    ])
  })
})
