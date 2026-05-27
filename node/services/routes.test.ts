import { resolveActiveCmsSource } from './routes'

describe('resolveActiveCmsSource (spec Decision 8 / FR-10)', () => {
  it('returns "none" when both flags are off (backwards-compatible default)', () => {
    expect(
      resolveActiveCmsSource({
        enableCmsRoutes: false,
        enableContentPlatformRoutes: false,
      })
    ).toBe('none')
  })

  it('returns "hcms" when only enableCmsRoutes is on', () => {
    expect(
      resolveActiveCmsSource({
        enableCmsRoutes: true,
        enableContentPlatformRoutes: false,
      })
    ).toBe('hcms')
  })

  it('returns "content-platform" when only enableContentPlatformRoutes is on', () => {
    expect(
      resolveActiveCmsSource({
        enableCmsRoutes: false,
        enableContentPlatformRoutes: true,
      })
    ).toBe('content-platform')
  })

  it('returns "content-platform" (Content Platform wins) when BOTH flags are on', () => {
    expect(
      resolveActiveCmsSource({
        enableCmsRoutes: true,
        enableContentPlatformRoutes: true,
      })
    ).toBe('content-platform')
  })

  it('treats missing/undefined settings as "none" (defensive)', () => {
    expect(resolveActiveCmsSource(undefined)).toBe('none')
    expect(resolveActiveCmsSource({})).toBe('none')
  })
})
