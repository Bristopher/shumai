import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { prisma, AssetStatus } from '@shumai/db'
import { setupTestDbHooks } from '@shumai/db/test'
import { workflowService, TaskQueueTranscode } from '@shumai/workflow-core'
import { initTranscodeWorkflows } from '@shumai/transcode'
import { s3Service } from '@shumai/core/src/s3/s3'
import { fileURLToPath } from 'url'
import * as path from 'path'
import * as fs from 'fs'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const transcodeWorkflowsPath = path.resolve(currentDir, '../../../apps/transcode/src/workflows.ts')
const fixturesDir = path.resolve(currentDir, '../fixtures')

describe.each(['local', 'temporal'] as const)(
  'Workflow E2E - transcodeImageWorkflow (executor: %s)',
  (mode) => {
    setupTestDbHooks()

    let transcodeWorkerPromise: Promise<void> | null = null

    beforeAll(async () => {
      process.env.S3_BUCKET = 'shumai-e2e-test-bucket-transcode'

      workflowService.setExecutorType(mode)
      initTranscodeWorkflows()

      if (mode === 'temporal') {
        console.log('Starting background worker for transcode Temporal E2E tests...')
        transcodeWorkerPromise = workflowService.startWorkers(TaskQueueTranscode, {
          workflowsPath: transcodeWorkflowsPath,
        })
        await new Promise((resolve) => setTimeout(resolve, 2000))
      } else {
        console.log('Starting local workflow service polling...')
        workflowService.start()
      }
    })

    afterAll(async () => {
      if (mode === 'temporal') {
        console.log('Shutting down Temporal workers...')
        await workflowService.shutdownWorkers()
        await Promise.all([transcodeWorkerPromise].filter(Boolean))
      }
      workflowService.close()
      vi.restoreAllMocks()
      try {
        console.log('Cleaning up local E2E storage files...')
        await s3Service.deletePrefix('shumai-e2e-test-bucket-transcode', '')
      } catch (err) {
        console.error('Failed to clean up E2E storage folder:', err)
      }
    })

    it('should run transcodeMedia workflow for an image asset successfully', async () => {
      // 1. Seed Database
      const team = await prisma.team.create({
        data: { name: 'E2E Image Transcode Team' },
      })

      const project = await prisma.project.create({
        data: { name: 'E2E Image Transcode Project', teamId: team.id },
      })

      const storageKey = await prisma.storageKey.create({
        data: {
          key: 'projects/e2e/image-trans.png',
        },
      })

      const asset = await prisma.asset.create({
        data: {
          name: 'image-trans.png',
          type: 'file',
          status: 'uploaded',
          mediaType: 'image/png',
          projectId: project.id,
          storageKeyId: storageKey.id,
        },
      })

      // 2. Seed S3 Storage from Fixture
      const pngPath = path.join(fixturesDir, 'small.png')
      const pngBuffer = fs.readFileSync(pngPath)
      await s3Service.putObject(
        'shumai-e2e-test-bucket-transcode',
        'projects/e2e/image-trans.png',
        pngBuffer,
        pngBuffer.length,
        'image/png',
      )

      // 3. Create Workflow Task
      const task = await prisma.workflowTask.create({
        data: {
          type: 'transcode_image',
          status: 'pending',
          assetId: asset.id,
          projectId: project.id,
          teamId: team.id,
          payload: {
            projectId: project.id,
            transcode: {
              thumbnail: true,
            },
          },
        },
      })

      // 4. Wait for workflow to complete
      console.log(
        `Submitted E2E Image Transcode Workflow Task. ID: ${task.id}. Awaiting completion...`,
      )
      const completedTask = await workflowService.executeWait(task, 45000)

      // 5. Verification
      expect(completedTask.status).toBe('completed')

      const updatedAsset = await prisma.asset.findUnique({
        where: { id: asset.id },
      })
      expect(updatedAsset?.status).toBe(AssetStatus.processed)

      const mediaInfo = updatedAsset?.media as unknown as {
        proxyType: string
        imageTranscodes: unknown[]
        thumbnail: unknown
      }
      expect(mediaInfo).toBeDefined()
      expect(mediaInfo.proxyType).toBe('image')
      expect(mediaInfo.imageTranscodes).toBeDefined()
      expect(mediaInfo.imageTranscodes.length).toBeGreaterThan(0)
      expect(mediaInfo.thumbnail).toBeDefined()
    }, 50000)

    it('should run transcodeMedia workflow for a PSD image asset successfully', async () => {
      // 1. Seed Database
      const team = await prisma.team.create({
        data: { name: 'E2E PSD Transcode Team' },
      })

      const project = await prisma.project.create({
        data: { name: 'E2E PSD Transcode Project', teamId: team.id },
      })

      const storageKey = await prisma.storageKey.create({
        data: {
          key: 'projects/e2e/test.psd',
        },
      })

      const asset = await prisma.asset.create({
        data: {
          name: 'test.psd',
          type: 'file',
          status: 'uploaded',
          mediaType: 'image/vnd.adobe.photoshop',
          projectId: project.id,
          storageKeyId: storageKey.id,
        },
      })

      // 2. Seed S3 Storage from fixture test.psd
      const psdPath = path.join(fixturesDir, 'test.psd')
      const psdBuffer = fs.readFileSync(psdPath)
      await s3Service.putObject(
        'shumai-e2e-test-bucket-transcode',
        'projects/e2e/test.psd',
        psdBuffer,
        psdBuffer.length,
        'image/vnd.adobe.photoshop',
      )

      // 3. Create Workflow Task
      const task = await prisma.workflowTask.create({
        data: {
          type: 'transcode_image',
          status: 'pending',
          assetId: asset.id,
          projectId: project.id,
          teamId: team.id,
          payload: {
            projectId: project.id,
            transcode: {
              thumbnail: true,
            },
          },
        },
      })

      // 4. Wait for workflow to complete
      console.log(
        `Submitted E2E PSD Image Transcode Workflow Task. ID: ${task.id}. Awaiting completion...`,
      )
      const completedTask = await workflowService.executeWait(task, 45000)

      // 5. Verification
      expect(completedTask.status).toBe('completed')

      const updatedAsset = await prisma.asset.findUnique({
        where: { id: asset.id },
      })
      expect(updatedAsset?.status).toBe(AssetStatus.processed)

      const mediaInfo = updatedAsset?.media as unknown as {
        proxyType: string
        imageTranscodes: unknown[]
        thumbnail: unknown
      }
      expect(mediaInfo).toBeDefined()
      expect(mediaInfo.proxyType).toBe('image')
      expect(mediaInfo.imageTranscodes).toBeDefined()
      expect(mediaInfo.imageTranscodes.length).toBeGreaterThan(0)
      expect(mediaInfo.thumbnail).toBeDefined()
    }, 50000)

    it('should run transcodeMedia workflow for a camera RAW asset from its embedded preview', async () => {
      // 1. Seed Database. RAW files arrive as octet-stream from browsers and the CLI.
      const team = await prisma.team.create({
        data: { name: 'E2E RAW Transcode Team' },
      })

      const project = await prisma.project.create({
        data: { name: 'E2E RAW Transcode Project', teamId: team.id },
      })

      const storageKey = await prisma.storageKey.create({
        data: {
          key: 'projects/e2e/small.RAF',
        },
      })

      const asset = await prisma.asset.create({
        data: {
          name: 'small.RAF',
          type: 'file',
          status: 'uploaded',
          mediaType: 'application/octet-stream',
          projectId: project.id,
          storageKeyId: storageKey.id,
        },
      })

      // 2. Seed S3 Storage from fixture small.raf: a RAF header around a real 600x400 JPEG
      // preview tagged EXIF orientation 6, so the displayed image is 400x600.
      const rafPath = path.join(fixturesDir, 'small.raf')
      const rafBuffer = fs.readFileSync(rafPath)
      await s3Service.putObject(
        'shumai-e2e-test-bucket-transcode',
        'projects/e2e/small.RAF',
        rafBuffer,
        rafBuffer.length,
        'application/octet-stream',
      )

      // 3. Create Workflow Task
      const task = await prisma.workflowTask.create({
        data: {
          type: 'transcode_image',
          status: 'pending',
          assetId: asset.id,
          projectId: project.id,
          teamId: team.id,
          payload: {
            projectId: project.id,
            transcode: {
              thumbnail: true,
            },
          },
        },
      })

      // 4. Wait for workflow to complete
      console.log(
        `Submitted E2E RAW Image Transcode Workflow Task. ID: ${task.id}. Awaiting completion...`,
      )
      const completedTask = await workflowService.executeWait(task, 45000)

      // 5. Verification
      expect(completedTask.status).toBe('completed')

      const updatedAsset = await prisma.asset.findUnique({
        where: { id: asset.id },
      })
      expect(updatedAsset?.status).toBe(AssetStatus.processed)

      const mediaInfo = updatedAsset?.media as unknown as {
        proxyType: string
        imageTranscodes: unknown[]
        thumbnail: unknown
        metadata: { originalWidth: number; originalHeight: number }
      }
      expect(mediaInfo).toBeDefined()
      expect(mediaInfo.proxyType).toBe('image')
      expect(mediaInfo.imageTranscodes).toBeDefined()
      expect(mediaInfo.imageTranscodes.length).toBeGreaterThan(0)
      expect(mediaInfo.thumbnail).toBeDefined()
      expect(mediaInfo.metadata.originalWidth).toBe(400)
      expect(mediaInfo.metadata.originalHeight).toBe(600)
    }, 50000)

    // XMP sidecars preview as the photo they describe (edits applied when darktable can render
    // them; this image has no darktable, and the fixture has no edits, so the photo is used).
    async function seedXmpPair(label: string, withPhoto: boolean) {
      const bucket = 'shumai-e2e-test-bucket-transcode'
      const team = await prisma.team.create({ data: { name: `E2E XMP ${label} Team` } })
      const project = await prisma.project.create({
        data: { name: `E2E XMP ${label} Project`, teamId: team.id },
      })
      const folder = await prisma.asset.create({
        data: { name: `xmp-${label}`, type: 'folder', status: 'processed', projectId: project.id },
      })
      const create = async (name: string, fixture: string, mediaType: string) => {
        const key = `projects/e2e/xmp-${label}/${name}`
        const buffer = fs.readFileSync(path.join(fixturesDir, fixture))
        await s3Service.putObject(bucket, key, buffer, buffer.length, mediaType)
        const storageKey = await prisma.storageKey.create({ data: { key } })
        return prisma.asset.create({
          data: {
            name,
            type: 'file',
            status: 'uploaded',
            mediaType,
            projectId: project.id,
            parentId: folder.id,
            storageKeyId: storageKey.id,
          },
        })
      }
      const xmp = await create('small.RAF.xmp', 'small.raf.xmp', 'application/rdf+xml')
      const photo = withPhoto
        ? await create('small.RAF', 'small.raf', 'application/octet-stream')
        : null
      return { team, project, xmp, photo, create }
    }

    const runImageTask = async (assetId: string, projectId: string, teamId: string) => {
      const task = await prisma.workflowTask.create({
        data: {
          type: 'transcode_image',
          status: 'pending',
          assetId,
          projectId,
          teamId,
          payload: { projectId, transcode: { thumbnail: true } },
        },
      })
      return workflowService.executeWait(task, 45000)
    }

    it('should preview an XMP sidecar as the photo it describes', async () => {
      const { team, project, xmp } = await seedXmpPair('paired', true)

      const completed = await runImageTask(xmp.id, project.id, team.id)
      expect(completed.status).toBe('completed')

      const updated = await prisma.asset.findUnique({ where: { id: xmp.id } })
      expect(updated?.status).toBe(AssetStatus.processed)
      const media = updated?.media as unknown as {
        proxyType: string
        thumbnail: unknown
        imageTranscodes: unknown[]
        metadata: { originalWidth: number; originalHeight: number }
      }
      expect(media.proxyType).toBe('image')
      expect(media.thumbnail).toBeDefined()
      expect(media.imageTranscodes.length).toBeGreaterThan(0)
      // The photo's own (oriented) preview size, not anything about the XMP text.
      expect(media.metadata.originalWidth).toBe(400)
      expect(media.metadata.originalHeight).toBe(600)
    }, 50000)

    it('should queue an XMP sidecar again once its late photo is processed', async () => {
      const { team, project, xmp, create } = await seedXmpPair('late', false)

      // 1. The sidecar arrives first: it finishes without a preview.
      const first = await runImageTask(xmp.id, project.id, team.id)
      expect(first.status).toBe('completed')
      const before = await prisma.asset.findUnique({ where: { id: xmp.id } })
      expect(before?.status).toBe(AssetStatus.processed)
      expect(before?.media).toBeNull()

      // 2. The photo arrives and is processed: the sidecar gets a new preview job.
      const photo = await create('small.RAF', 'small.raf', 'application/octet-stream')
      const second = await runImageTask(photo.id, project.id, team.id)
      expect(second.status).toBe('completed')

      const requeued = await prisma.workflowTask.findMany({
        where: { assetId: xmp.id, type: 'transcode_image' },
      })
      expect(requeued.length).toBe(2)
    }, 90000)
  },
)
