import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('child_process', () => ({ execFile: execFileMock }))
vi.mock('@shumai/core/src/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

import { logger } from '@shumai/core/src/logger'
import {
  applySharpThreads,
  applyTranscodeNice,
  createExecFileAsync,
  getThreadLimitEnv,
  getTranscodeNice,
  getTranscodeThreads,
  parsePositiveIntEnv,
  resetResourceLimitWarnings,
  resolveFfmpegThreads,
} from './resource-limits'

describe('resource-limits', () => {
  const saved = { threads: process.env.TRANSCODE_THREADS, nice: process.env.TRANSCODE_NICE }

  beforeEach(() => {
    delete process.env.TRANSCODE_THREADS
    delete process.env.TRANSCODE_NICE
    resetResourceLimitWarnings()
    vi.clearAllMocks()
  })

  afterEach(() => {
    if (saved.threads === undefined) delete process.env.TRANSCODE_THREADS
    else process.env.TRANSCODE_THREADS = saved.threads
    if (saved.nice === undefined) delete process.env.TRANSCODE_NICE
    else process.env.TRANSCODE_NICE = saved.nice
  })

  describe('parsePositiveIntEnv', () => {
    it('returns undefined silently when unset or empty', () => {
      expect(parsePositiveIntEnv('X', undefined)).toBeUndefined()
      expect(parsePositiveIntEnv('X', '  ')).toBeUndefined()
      expect(logger.warn).not.toHaveBeenCalled()
    })

    it('parses positive whole numbers', () => {
      expect(parsePositiveIntEnv('X', '4')).toBe(4)
      expect(parsePositiveIntEnv('X', ' 12 ')).toBe(12)
    })

    it.each(['abc', '0', '-2', '1.5', '2x', '1e3', 'NaN'])(
      'falls back to undefined with a warning for %s',
      (value) => {
        expect(parsePositiveIntEnv('X', value)).toBeUndefined()
        expect(logger.warn).toHaveBeenCalledTimes(1)
      },
    )

    it('warns only once per bad value', () => {
      parsePositiveIntEnv('X', 'bad')
      parsePositiveIntEnv('X', 'bad')
      expect(logger.warn).toHaveBeenCalledTimes(1)
    })
  })

  describe('TRANSCODE_THREADS', () => {
    it('is undefined by default so behaviour is unchanged', () => {
      expect(getTranscodeThreads()).toBeUndefined()
      expect(resolveFfmpegThreads(undefined)).toBeUndefined()
      expect(resolveFfmpegThreads(0)).toBeUndefined()
      expect(getThreadLimitEnv()).toBeUndefined()
    })

    it('is used as the ffmpeg default but never overrides an explicit value', () => {
      process.env.TRANSCODE_THREADS = '3'
      expect(resolveFfmpegThreads(undefined)).toBe(3)
      expect(resolveFfmpegThreads(0)).toBe(3)
      expect(resolveFfmpegThreads(6)).toBe(6)
    })

    it('caps OpenMP based tools', () => {
      process.env.TRANSCODE_THREADS = '2'
      expect(getThreadLimitEnv()).toEqual({ OMP_NUM_THREADS: '2', MAGICK_THREAD_LIMIT: '2' })
    })

    it('limits the sharp thread pool only when set', () => {
      const concurrency = vi.fn()
      applySharpThreads({ concurrency })
      expect(concurrency).not.toHaveBeenCalled()
      process.env.TRANSCODE_THREADS = '2'
      applySharpThreads({ concurrency })
      expect(concurrency).toHaveBeenCalledWith(2)
      expect(() => applySharpThreads({})).not.toThrow()
    })

    it('ignores invalid values', () => {
      process.env.TRANSCODE_THREADS = '0'
      expect(getTranscodeThreads()).toBeUndefined()
      expect(resolveFfmpegThreads(undefined)).toBeUndefined()
    })
  })

  describe('TRANSCODE_NICE', () => {
    it('is off by default and leaves commands untouched', () => {
      expect(getTranscodeNice(process.env, 'linux')).toBeUndefined()
      expect(applyTranscodeNice('ffmpeg', ['-y'])).toEqual(['ffmpeg', ['-y']])
    })

    it('is ignored with a warning off Linux', () => {
      expect(getTranscodeNice({ TRANSCODE_NICE: '10' }, 'win32')).toBeUndefined()
      expect(logger.warn).toHaveBeenCalledTimes(1)
    })

    it('clamps to 19 and rejects invalid input on Linux', () => {
      expect(getTranscodeNice({ TRANSCODE_NICE: '10' }, 'linux')).toBe(10)
      expect(getTranscodeNice({ TRANSCODE_NICE: '99' }, 'linux')).toBe(19)
      expect(getTranscodeNice({ TRANSCODE_NICE: '-5' }, 'linux')).toBeUndefined()
      expect(getTranscodeNice({ TRANSCODE_NICE: 'x' }, 'linux')).toBeUndefined()
    })

    it('wraps spawned commands in nice when active', () => {
      const original = Object.getOwnPropertyDescriptor(process, 'platform')!
      Object.defineProperty(process, 'platform', { value: 'linux' })
      try {
        process.env.TRANSCODE_NICE = '10'
        expect(applyTranscodeNice('ffmpeg', ['-y', 'a'])).toEqual([
          'nice',
          ['-n', '10', 'ffmpeg', '-y', 'a'],
        ])
      } finally {
        Object.defineProperty(process, 'platform', original)
      }
    })
  })

  describe('createExecFileAsync', () => {
    it('passes command, args and options straight through by default', async () => {
      execFileMock.mockImplementation((...a: unknown[]) => {
        const cb = a[a.length - 1] as (e: Error | null, r: { stdout: string }) => void
        cb(null, { stdout: 'ok' })
      })
      const run = createExecFileAsync()
      await run('ffprobe', ['-v', 'error'])
      expect(execFileMock.mock.calls[0].slice(0, 2)).toEqual(['ffprobe', ['-v', 'error']])
      const signal = new AbortController().signal
      await run('ffmpeg', ['-y'], { signal })
      expect(execFileMock.mock.calls[1].slice(0, 3)).toEqual(['ffmpeg', ['-y'], { signal }])
    })
  })
})
