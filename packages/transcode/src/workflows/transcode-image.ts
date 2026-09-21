import type { WorkflowTask } from '@shumai/db'
import '@shumai/db/src/prisma-json-types'
import { executeActivity, getActivities } from '@shumai/workflow-core'
import {
  getWorkerQueueAndStartTask,
  fetchAssetWithKey,
  completeTask,
  failTask,
  cleanupTmpDir,
} from './common'

export async function transcodeImageWorkflow(task: WorkflowTask): Promise<void> {
  let tmpDir: string | undefined
  let sourceTmpDir: string | undefined
  let workerQueue = ''

  try {
    workerQueue = await getWorkerQueueAndStartTask(task)

    const {
      updateAssetStatusActivity,
      getMediaInfoActivity,
      transcodeImageActivity,
      updateAssetMediaActivity,
      downloadMediaToTmpActivity,
      createEmbeddingTaskIfEnabledActivity,
      createAutofillTaskIfEnabledActivity,
      resolveXmpSourceActivity,
      renderXmpPreviewActivity,
      requeueXmpSiblingsActivity,
    } = getActivities()

    await executeActivity(workerQueue, updateAssetStatusActivity, {
      assetId: task.assetId,
      status: 'processing',
    })

    const { asset, key } = await fetchAssetWithKey(workerQueue, task.assetId)

    const download = await executeActivity(workerQueue, downloadMediaToTmpActivity, {
      assetKey: key,
    })
    let { filePath } = download
    tmpDir = download.tmpDir

    // An XMP sidecar previews as the photo it describes, with its edits applied when they can be
    // rendered (SHUMAI-011). A plain string check keeps workflow code free of extra imports.
    const isXmp = (asset.name || '').toLowerCase().endsWith('.xmp')
    if (isXmp) {
      const source = await executeActivity(workerQueue, resolveXmpSourceActivity, {
        assetId: asset.id,
      })
      if (!source) {
        // The photo is not uploaded yet. Finish without media; when the photo is processed,
        // requeueXmpSiblingsActivity queues this sidecar again.
        await executeActivity(workerQueue, updateAssetStatusActivity, {
          assetId: asset.id,
          status: 'processed',
        })
        await completeTask(workerQueue, task.id)
        return
      }
      const photo = await executeActivity(workerQueue, downloadMediaToTmpActivity, {
        assetKey: source.key,
      })
      sourceTmpDir = photo.tmpDir
      const rendered = await executeActivity(workerQueue, renderXmpPreviewActivity, {
        xmpPath: filePath,
        photoPath: photo.filePath,
      })
      filePath = rendered.path
    }

    const spec = task.payload?.transcode || {}
    const mediaInfo = await executeActivity(workerQueue, getMediaInfoActivity, {
      filePath,
      assetId: asset.id,
      proxyType: 'image',
      mediaType: asset.mediaType || '',
    })

    mediaInfo.original = {
      key,
      filesizeInBytes: 0,
      codec: '',
    }

    const metadata = mediaInfo.metadata

    const isImage = mediaInfo.proxyType === 'image'
    if (isImage && metadata) {
      const imageSpec: PrismaJson.ImageTranscode = {
        width: metadata.originalWidth,
        height: metadata.originalHeight,
        quality: 90,
        format: 'webp',
      }
      const imageTranscode = await executeActivity(workerQueue, transcodeImageActivity, {
        assetKey: key,
        filePath,
        imageSpec,
      })
      mediaInfo.imageTranscodes.push(imageTranscode)
    }

    if (spec.thumbnail) {
      const thumbTranscode = await executeActivity(workerQueue, transcodeImageActivity, {
        assetKey: key,
        filePath,
        imageSpec: { width: 300, height: 300, quality: 80, format: 'webp', isPreview: true },
      })
      mediaInfo.thumbnail = thumbTranscode
    }

    await executeActivity(workerQueue, updateAssetMediaActivity, {
      assetId: asset.id,
      mediaInfo,
    })

    await executeActivity(workerQueue, updateAssetStatusActivity, {
      assetId: asset.id,
      status: 'processed',
    })

    if (!isXmp) {
      await executeActivity(workerQueue, requeueXmpSiblingsActivity, { assetId: asset.id })
    }

    await executeActivity(workerQueue, createEmbeddingTaskIfEnabledActivity, {
      assetId: asset.id,
      teamId: task.teamId,
      projectId: task.projectId,
    })

    await executeActivity(workerQueue, createAutofillTaskIfEnabledActivity, {
      assetId: asset.id,
      teamId: task.teamId,
      projectId: task.projectId,
    })

    await completeTask(workerQueue, task.id)
  } catch (err) {
    console.error(`transcodeImageWorkflow failed for task ${task.id}:`, err)
    await failTask(workerQueue, task.id, err)
    throw err
  } finally {
    await cleanupTmpDir(workerQueue, tmpDir)
    await cleanupTmpDir(workerQueue, sourceTmpDir)
  }
}
