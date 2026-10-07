import { describe, expect, it } from 'vitest'

// Regression: the production entry (apps/web/src/index.ts) loads asset.ts first, and asset.ts reaches
// search.ts through asset -> upload -> transcode -> activities/transcode -> photo/photographer ->
// search. search.ts therefore evaluates while `assetService` is still uninitialized, and a
// `new SearchService()` that captured it as a default parameter kept `undefined` for good
// ("undefined is not an object (evaluating 'this.assetSvc.listAssetsByIds')").
describe('SearchService module load order', () => {
  it('resolves the asset service even when search.ts loads inside the asset.ts import cycle', async () => {
    const { assetService } = await import('@shumai/core/src/asset/asset')
    const { searchService } = await import('@shumai/core/src/search/search')

    expect(assetService).toBeDefined()
    expect((searchService as unknown as { assetSvc: unknown }).assetSvc).toBe(assetService)
  })

  it('prefers an injected asset service over the singleton', async () => {
    const { SearchService } = await import('@shumai/core/src/search/search')
    const injected = {} as never
    expect(
      (new SearchService(undefined, injected) as unknown as { assetSvc: unknown }).assetSvc,
    ).toBe(injected)
  })
})
