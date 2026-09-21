import { describe, it, expect, vi, beforeEach } from 'vitest'
import { transcodeImageWorkflow } from './transcode-image'
import { WorkflowTask, WorkflowTaskStatus, WorkflowTaskType, AssetStatus } from '@shumai/db'
import * as workflowUtils from '@shumai/workflow-core'

vi.mock('@shumai/workflow-core', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actual = (await importOriginal()) as any
  return {
    ...actual,
    getActivities: vi.fn(),
    executeActivity: vi.fn(),
    sleep: vi.fn(),
  }
})

describe('transcodeImageWorkflow', () => {
  const mockActivities = {
    updateTaskStatusActivity: Object.assign(vi.fn(), {
      _activityName: 'updateTaskStatusActivity',
    }),
    updateAssetStatusActivity: Object.assign(vi.fn(), {
      _activityName: 'updateAssetStatusActivity',
    }),
    getAssetActivity: Object.assign(vi.fn(), { _activityName: 'getAssetActivity' }),
    getMediaInfoActivity: Object.assign(vi.fn(), { _activityName: 'getMediaInfoActivity' }),
    transcodeImageActivity: Object.assign(vi.fn(), { _activityName: 'transcodeImageActivity' }),
    updateAssetMediaActivity: Object.assign(vi.fn(), {
      _activityName: 'updateAssetMediaActivity',
    }),
    getTranscodeWorkerQueueActivity: Object.assign(vi.fn(), {
      _activityName: 'getTranscodeWorkerQueueActivity',
    }),
    downloadMediaToTmpActivity: Object.assign(vi.fn(), {
      _activityName: 'downloadMediaToTmpActivity',
    }),
    cleanupTmpDirActivity: Object.assign(vi.fn(), { _activityName: 'cleanupTmpDirActivity' }),
    createEmbeddingTaskIfEnabledActivity: Object.assign(vi.fn(), {
      _activityName: 'createEmbeddingTaskIfEnabledActivity',
    }),
    createAutofillTaskIfEnabledActivity: Object.assign(vi.fn(), {
      _activityName: 'createAutofillTaskIfEnabledActivity',
    }),
    resolveXmpSourceActivity: Object.assign(vi.fn(), {
      _activityName: 'resolveXmpSourceActivity',
    }),
    renderXmpPreviewActivity: Object.assign(vi.fn(), {
      _activityName: 'renderXmpPreviewActivity',
    }),
    requeueXmpSiblingsActivity: Object.assign(vi.fn(), {
      _activityName: 'requeueXmpSiblingsActivity',
    }),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(workflowUtils.getActivities as any).mockReturnValue(mockActivities)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(workflowUtils.executeActivity as any).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (_queue: string, fn: any, ...args: any[]) => {
        if (typeof fn !== 'function') {
          throw new Error(`fn is not a function in executeActivity. Queue: ${_queue}`)
        }
        return fn(...args)
      },
    )

    mockActivities.getTranscodeWorkerQueueActivity.mockResolvedValue('transcode_worker_queue')
    mockActivities.downloadMediaToTmpActivity.mockResolvedValue({
      filePath: '/tmp/image.jpg',
      tmpDir: '/tmp',
    })
  })

  it('should process image transcode and thumbnail successfully', async () => {
    const task: WorkflowTask = {
      id: 'task-image',
      assetId: 'asset-image',
      type: WorkflowTaskType.transcode_image,
      status: WorkflowTaskStatus.pending,
      sessionId: null,
      output: null,
      payload: {
        projectId: 'proj-1',
        transcode: {
          thumbnail: true,
        },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
      heartbeat: null,
      teamId: 'team-1',
      projectId: 'proj-1',
      uid: 'task-uid',
      model: null,
      inputTokens: 0,
      outputTokens: 0,
    }

    mockActivities.getAssetActivity.mockResolvedValue({
      id: 'asset-image',
      storageKey: { key: 'image.jpg' },
      mediaType: 'image/jpeg',
    })

    mockActivities.getMediaInfoActivity.mockResolvedValue({
      proxyType: 'image',
      metadata: {
        originalWidth: 1000,
        originalHeight: 1000,
        duration: 0,
        frameRate: 0,
        totalFrames: 0,
        startTimecode: '00:00:00:00',
        bitRate: 0,
        hasAudio: false,
        format: {},
      },
      videoTranscodes: [],
      imageTranscodes: [],
    })

    mockActivities.transcodeImageActivity.mockResolvedValue({
      key: 't.webp',
      width: 300,
      height: 300,
      format: 'webp',
    })

    await transcodeImageWorkflow(task)

    expect(mockActivities.updateAssetStatusActivity).toHaveBeenCalledWith({
      assetId: 'asset-image',
      status: AssetStatus.processing,
    })

    expect(mockActivities.updateAssetMediaActivity).toHaveBeenCalledWith({
      assetId: 'asset-image',
      mediaInfo: expect.objectContaining({
        thumbnail: expect.objectContaining({
          key: 't.webp',
          width: 300,
          height: 300,
        }),
      }),
    })

    expect(mockActivities.updateAssetStatusActivity).toHaveBeenCalledWith({
      assetId: 'asset-image',
      status: AssetStatus.processed,
    })

    expect(mockActivities.createEmbeddingTaskIfEnabledActivity).toHaveBeenCalledWith({
      assetId: 'asset-image',
      teamId: 'team-1',
      projectId: 'proj-1',
    })

    expect(mockActivities.createAutofillTaskIfEnabledActivity).toHaveBeenCalledWith({
      assetId: 'asset-image',
      teamId: 'team-1',
      projectId: 'proj-1',
    })

    // A processed photo re-queues any XMP sidecar of it that finished first without media.
    expect(mockActivities.requeueXmpSiblingsActivity).toHaveBeenCalledWith({
      assetId: 'asset-image',
    })
    expect(mockActivities.resolveXmpSourceActivity).not.toHaveBeenCalled()
  })

  const xmpTask = (): WorkflowTask =>
    ({
      id: 'task-xmp',
      assetId: 'asset-xmp',
      type: WorkflowTaskType.transcode_image,
      status: WorkflowTaskStatus.pending,
      payload: { projectId: 'proj-1', transcode: { thumbnail: true } },
      teamId: 'team-1',
      projectId: 'proj-1',
    }) as unknown as WorkflowTask

  it('should preview an XMP sidecar from its photo, rendered with its edits', async () => {
    mockActivities.getAssetActivity.mockResolvedValue({
      id: 'asset-xmp',
      name: 'DSCF5543.RAF.xmp',
      storageKey: { key: 'files/x/DSCF5543.RAF.xmp' },
      mediaType: 'application/rdf+xml',
    })
    mockActivities.downloadMediaToTmpActivity
      .mockResolvedValueOnce({ filePath: '/tmp/a/DSCF5543.RAF.xmp', tmpDir: '/tmp/a' })
      .mockResolvedValueOnce({ filePath: '/tmp/b/DSCF5543.RAF', tmpDir: '/tmp/b' })
    mockActivities.resolveXmpSourceActivity.mockResolvedValue({
      key: 'files/y/DSCF5543.RAF',
      name: 'DSCF5543.RAF',
    })
    mockActivities.renderXmpPreviewActivity.mockResolvedValue({
      path: '/tmp/a/xmp-render-1.jpg',
      outcome: 'applied',
      editor: 'darktable',
    })
    mockActivities.getMediaInfoActivity.mockResolvedValue({
      proxyType: 'image',
      metadata: { originalWidth: 2560, originalHeight: 3840 },
      videoTranscodes: [],
      imageTranscodes: [],
    })
    mockActivities.transcodeImageActivity.mockResolvedValue({ key: 'x.webp', format: 'webp' })

    await transcodeImageWorkflow(xmpTask())

    expect(mockActivities.downloadMediaToTmpActivity).toHaveBeenNthCalledWith(2, {
      assetKey: 'files/y/DSCF5543.RAF',
    })
    expect(mockActivities.renderXmpPreviewActivity).toHaveBeenCalledWith({
      xmpPath: '/tmp/a/DSCF5543.RAF.xmp',
      photoPath: '/tmp/b/DSCF5543.RAF',
    })
    // Everything downstream works on the rendered image, but outputs sit beside the sidecar.
    expect(mockActivities.getMediaInfoActivity).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/tmp/a/xmp-render-1.jpg', assetId: 'asset-xmp' }),
    )
    expect(mockActivities.transcodeImageActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        assetKey: 'files/x/DSCF5543.RAF.xmp',
        filePath: '/tmp/a/xmp-render-1.jpg',
      }),
    )
    expect(mockActivities.requeueXmpSiblingsActivity).not.toHaveBeenCalled()
    expect(mockActivities.cleanupTmpDirActivity).toHaveBeenCalledWith({ tmpDir: '/tmp/a' })
    expect(mockActivities.cleanupTmpDirActivity).toHaveBeenCalledWith({ tmpDir: '/tmp/b' })
  })

  it('should finish an XMP sidecar without media while its photo is not there yet', async () => {
    mockActivities.getAssetActivity.mockResolvedValue({
      id: 'asset-xmp',
      name: 'DSCF5543.RAF.xmp',
      storageKey: { key: 'files/x/DSCF5543.RAF.xmp' },
      mediaType: 'application/rdf+xml',
    })
    mockActivities.resolveXmpSourceActivity.mockResolvedValue(null)

    await transcodeImageWorkflow(xmpTask())

    expect(mockActivities.updateAssetStatusActivity).toHaveBeenCalledWith({
      assetId: 'asset-xmp',
      status: AssetStatus.processed,
    })
    expect(mockActivities.updateTaskStatusActivity).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-xmp', status: WorkflowTaskStatus.completed }),
    )
    expect(mockActivities.renderXmpPreviewActivity).not.toHaveBeenCalled()
    expect(mockActivities.updateAssetMediaActivity).not.toHaveBeenCalled()
  })
})
