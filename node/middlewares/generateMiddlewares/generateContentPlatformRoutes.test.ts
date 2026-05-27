import {
  IOContext,
  Logger,
  RequestConfig,
  Tenant,
  TenantClient,
  VBase,
  VBaseSaveResponse,
} from '@vtex/api'
import * as TypeMoq from 'typemoq'

import { Clients } from '../../clients'
import {
  CmsContentTypeSchema,
  CmsDataPlane,
  CmsEntry,
  DataPlaneListResponse,
} from '../../clients/cmsDataPlane'
import {
  CONTENT_PLATFORM_ROUTES_PREFIX,
  getBucket,
  hashString,
} from '../../utils'
import { generateContentPlatformRoutes } from './generateContentPlatformRoutes'
import {
  CONTENT_PLATFORM_ROUTES_INDEX,
  SitemapEntry,
  SitemapIndex,
} from './utils'

const tenantTypeMock = TypeMoq.Mock.ofInstance(TenantClient)
const vbaseTypeMock = TypeMoq.Mock.ofInstance(VBase)
const cmsDataPlaneTypeMock = TypeMoq.Mock.ofInstance(CmsDataPlane)
const contextMock = TypeMoq.Mock.ofType<EventContext>()
const ioContext = TypeMoq.Mock.ofType<IOContext>()
const state = TypeMoq.Mock.ofType<State>()

interface LoggerCapture {
  info: jest.Mock
  warn: jest.Mock
  error: jest.Mock
}

const makeLogger = (): LoggerCapture => ({
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
})

const bucketFor = (bindingId: string) =>
  getBucket(CONTENT_PLATFORM_ROUTES_PREFIX, hashString(bindingId))

const collectPaths = (entries: SitemapEntry[]): string[] =>
  entries.reduce<string[]>(
    (acc, entry) => acc.concat(entry.routes.map(r => r.path)),
    []
  )

interface DataPlaneMockBehavior {
  schemas: CmsContentTypeSchema[]
  entriesByType: Record<string, CmsEntry[]>
  schemasEtag?: string
  entriesEtagByType?: Record<string, string>
  /** When set, listEntries(contentType) responds 304 the FIRST time. */
  notModifiedTypes?: Set<string>
}

interface BuildContextOptions {
  dataPlane: DataPlaneMockBehavior
  enableCmsRoutes?: boolean
  enableContentPlatformRoutes?: boolean
  disableRoutesTerm?: string
  bindings?: Tenant['bindings']
  /**
   * Pre-existing VBase state. Each key is `bucket:file`, value is the
   * deserialized JSON content. Used to test ETag short-circuit and
   * regression-on-error behavior.
   */
  initialVbase?: Record<string, any>
}

const defaultBindings = ([
  {
    canonicalBaseAddress: 'www.host.com',
    defaultLocale: 'en-US',
    id: '1',
    targetProduct: 'vtex-storefront',
  },
  {
    canonicalBaseAddress: 'www.host.com/br',
    defaultLocale: 'pt-BR',
    id: '2',
    targetProduct: 'vtex-storefront',
  },
] as unknown) as Tenant['bindings']

const buildContext = (options: BuildContextOptions): EventContext => {
  const {
    dataPlane,
    enableCmsRoutes = false,
    enableContentPlatformRoutes = true,
    disableRoutesTerm = '',
    bindings = defaultBindings,
    initialVbase = {},
  } = options
  const logger = makeLogger()

  // tslint:disable-next-line:max-classes-per-file
  const vbaseImpl = class VBaseMock extends vbaseTypeMock.object {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public jsonData: Record<string, Record<string, any>> = {}

    constructor() {
      super(ioContext.object)
      // Seed with `bucket:file` shaped keys for convenience in tests.
      for (const key of Object.keys(initialVbase)) {
        const [bucket, file] = key.split(':')
        if (!this.jsonData[bucket]) {
          this.jsonData[bucket] = {}
        }
        this.jsonData[bucket][file] = initialVbase[key]
      }
    }

    public getJSON = async <T>(
      bucket: string,
      file: string,
      nullOrUndefined?: boolean
    ): Promise<T> => {
      if (!this.jsonData[bucket]?.[file] && nullOrUndefined) {
        return (null as unknown) as T
      }
      return Promise.resolve(this.jsonData[bucket]?.[file] as T)
    }

    public saveJSON = async <T>(
      bucket: string,
      file: string,
      data: T
    ): Promise<VBaseSaveResponse> => {
      if (!this.jsonData[bucket]) {
        this.jsonData[bucket] = {}
      }
      this.jsonData[bucket][file] = data
      return ({ updated: true } as unknown) as VBaseSaveResponse
    }
  }

  // tslint:disable-next-line:max-classes-per-file
  const tenant = class TenantMock extends tenantTypeMock.object {
    constructor() {
      super(ioContext.object)
    }

    public info = async (_?: RequestConfig) => ({ bindings } as Tenant)
  }

  let listEntriesCalls = 0

  // tslint:disable-next-line:max-classes-per-file
  const cmsDataPlane = class CmsDataPlaneMock extends cmsDataPlaneTypeMock.object {
    constructor() {
      super(ioContext.object)
    }

    public resolveProductionBranch = async () => ({ id: 'production' })

    public listSchemas = async (): Promise<
      DataPlaneListResponse<CmsContentTypeSchema[]>
    > => ({
      data: dataPlane.schemas,
      etag: dataPlane.schemasEtag,
      notModified: false,
    })

    public listEntries = async ({
      contentType,
    }: {
      contentType: string
      branch: string
      etag?: string
    }): Promise<DataPlaneListResponse<CmsEntry[]>> => {
      listEntriesCalls += 1
      if (dataPlane.notModifiedTypes?.has(contentType)) {
        return {
          etag: dataPlane.entriesEtagByType?.[contentType],
          notModified: true,
        }
      }
      return {
        data: dataPlane.entriesByType[contentType] ?? [],
        etag: dataPlane.entriesEtagByType?.[contentType],
        notModified: false,
      }
    }
  }

  // tslint:disable-next-line:max-classes-per-file
  const ClientsImpl = class ClientsMock extends Clients {
    get vbase() {
      return this.getOrSet('vbase', vbaseImpl)
    }

    get tenant() {
      return this.getOrSet('tenant', tenant)
    }

    get cmsDataPlane() {
      return this.getOrSet('cmsDataPlane', cmsDataPlane)
    }
  }

  const context = {
    ...contextMock.object,
    body: {
      generationId: 'gen-1',
    },
    clients: new ClientsImpl({}, ioContext.object),
    state: {
      ...state.object,
      settings: {
        disableRoutesTerm,
        enableAppsRoutes: true,
        enableCmsRoutes,
        enableContentPlatformRoutes,
        enableNavigationRoutes: true,
        enableProductRoutes: true,
        ignoreBindings: false,
      },
    },
    vtex: {
      ...ioContext.object,
      logger: (logger as unknown) as Logger,
    },
  } as EventContext

  // Expose for assertions in the test bodies.
  ;(context as any).__logger = logger
  ;(context as any).__listEntriesCalls = () => listEntriesCalls

  return context
}

describe('generateContentPlatformRoutes', () => {
  let next: jest.Mock

  beforeEach(() => {
    next = jest.fn()
  })

  it('ingests landingPage entries published on the production branch and writes them to VBase (US-1)', async () => {
    const context = buildContext({
      dataPlane: {
        entriesByType: {
          landingPage: [
            {
              contentType: 'landingPage',
              id: 'lp-1',
              lastModified: '2026-05-20T12:00:00.000Z',
              publishedLocales: [
                { locale: 'en-US', path: '/our-story' },
              ],
            },
          ],
        },
        schemas: [
          {
            classification: 'landing',
            contentType: 'landingPage',
            fields: [{ name: 'path', type: 'string' }, { name: 'title' }],
          },
        ],
      },
    })

    await generateContentPlatformRoutes(context, next)
    expect(next).toBeCalled()

    const { vbase } = context.clients
    const index = await vbase.getJSON<SitemapIndex>(
      bucketFor('1'),
      CONTENT_PLATFORM_ROUTES_INDEX,
      true
    )
    expect(index).not.toBeNull()
    expect(index.index.length).toBeGreaterThan(0)

    const entries = await Promise.all(
      index.index.map(file =>
        vbase.getJSON<SitemapEntry>(bucketFor('1'), file, true)
      )
    )
    expect(collectPaths(entries)).toEqual(['/our-story'])
  })

  it('also ingests custom content types whose schema declares a path field (US-1, schema-driven discovery — Decision 9)', async () => {
    const context = buildContext({
      dataPlane: {
        entriesByType: {
          microsite: [
            {
              contentType: 'microsite',
              id: 'ms-1',
              lastModified: '2026-05-20T12:00:00.000Z',
              publishedLocales: [{ locale: 'en-US', path: '/microsite/holiday' }],
            },
          ],
        },
        schemas: [
          {
            classification: 'custom',
            contentType: 'microsite',
            fields: [{ name: 'path' }, { name: 'hero' }],
          },
        ],
      },
    })

    await generateContentPlatformRoutes(context, next)
    const { vbase } = context.clients
    const index = await vbase.getJSON<SitemapIndex>(
      bucketFor('1'),
      CONTENT_PLATFORM_ROUTES_INDEX,
      true
    )
    const entries = await Promise.all(
      index.index.map(file =>
        vbase.getJSON<SitemapEntry>(bucketFor('1'), file, true)
      )
    )
    expect(collectPaths(entries)).toEqual(['/microsite/holiday'])
  })

  it('emits content-platform-new-routable-type the first time a new routable schema is seen (Decision 9)', async () => {
    const context = buildContext({
      dataPlane: {
        entriesByType: {
          microsite: [
            {
              contentType: 'microsite',
              id: 'ms-1',
              lastModified: '2026-05-20T12:00:00.000Z',
              publishedLocales: [{ locale: 'en-US', path: '/microsite/holiday' }],
            },
          ],
        },
        schemas: [
          {
            contentType: 'microsite',
            fields: [{ name: 'path' }],
          },
        ],
      },
    })

    await generateContentPlatformRoutes(context, next)

    const logger = (context as any).__logger as LoggerCapture
    const types = logger.info.mock.calls.map(call => call[0]?.type)
    expect(types).toContain('content-platform-new-routable-type')

    // Second run: history is persisted in VBase, so no second emit for the
    // same type (avoids log spam across regenerations).
    logger.info.mockClear()
    await generateContentPlatformRoutes(context, next)
    const typesSecondRun = logger.info.mock.calls.map(call => call[0]?.type)
    expect(typesSecondRun).not.toContain('content-platform-new-routable-type')
  })

  it('excludes PDP/PLP/search content types from ingestion even when they declare a path field (Decision 9 — catalog-owned templates)', async () => {
    const context = buildContext({
      dataPlane: {
        entriesByType: {
          landingPage: [
            {
              contentType: 'landingPage',
              id: 'lp-1',
              lastModified: '2026-05-20T12:00:00.000Z',
              publishedLocales: [{ locale: 'en-US', path: '/our-story' }],
            },
          ],
          pdpTemplate: [
            {
              contentType: 'pdpTemplate',
              id: 'p-1',
              lastModified: '2026-05-20T12:00:00.000Z',
              publishedLocales: [{ locale: 'en-US', path: '/p/123' }],
            },
          ],
          plpTemplate: [
            {
              contentType: 'plpTemplate',
              id: 'plp-1',
              lastModified: '2026-05-20T12:00:00.000Z',
              publishedLocales: [{ locale: 'en-US', path: '/category/foo' }],
            },
          ],
          searchTemplate: [
            {
              contentType: 'searchTemplate',
              id: 's-1',
              lastModified: '2026-05-20T12:00:00.000Z',
              publishedLocales: [{ locale: 'en-US', path: '/search' }],
            },
          ],
        },
        schemas: [
          {
            classification: 'pdp',
            contentType: 'pdpTemplate',
            fields: [{ name: 'path' }],
          },
          {
            classification: 'plp',
            contentType: 'plpTemplate',
            fields: [{ name: 'path' }],
          },
          {
            classification: 'search',
            contentType: 'searchTemplate',
            fields: [{ name: 'path' }],
          },
          {
            classification: 'landing',
            contentType: 'landingPage',
            fields: [{ name: 'path' }],
          },
        ],
      },
    })

    await generateContentPlatformRoutes(context, next)

    const { vbase } = context.clients
    const index = await vbase.getJSON<SitemapIndex>(
      bucketFor('1'),
      CONTENT_PLATFORM_ROUTES_INDEX,
      true
    )
    const entries = await Promise.all(
      (index?.index ?? []).map(file =>
        vbase.getJSON<SitemapEntry>(bucketFor('1'), file, true)
      )
    )
    expect(collectPaths(entries)).toEqual(['/our-story'])
  })

  it('excludes entries with noindex=true (US-2 — Decision 10)', async () => {
    const context = buildContext({
      dataPlane: {
        entriesByType: {
          landingPage: [
            {
              contentType: 'landingPage',
              id: 'keep',
              lastModified: '2026-05-20T12:00:00.000Z',
              publishedLocales: [{ locale: 'en-US', path: '/keep' }],
              seo: { noindex: false },
            },
            {
              contentType: 'landingPage',
              id: 'hidden',
              lastModified: '2026-05-20T12:00:00.000Z',
              publishedLocales: [{ locale: 'en-US', path: '/hidden' }],
              seo: { noindex: true },
            },
          ],
        },
        schemas: [
          { contentType: 'landingPage', fields: [{ name: 'path' }] },
        ],
      },
    })
    await generateContentPlatformRoutes(context, next)

    const { vbase } = context.clients
    const index = await vbase.getJSON<SitemapIndex>(
      bucketFor('1'),
      CONTENT_PLATFORM_ROUTES_INDEX,
      true
    )
    const entries = await Promise.all(
      index.index.map(file =>
        vbase.getJSON<SitemapEntry>(bucketFor('1'), file, true)
      )
    )
    expect(collectPaths(entries)).toEqual(['/keep'])
  })

  it('excludes entries whose canonical points to a different URL than the entry path (US-2 — Decision 10)', async () => {
    const context = buildContext({
      dataPlane: {
        entriesByType: {
          landingPage: [
            {
              contentType: 'landingPage',
              id: 'keep',
              lastModified: '2026-05-20T12:00:00.000Z',
              publishedLocales: [{ locale: 'en-US', path: '/promo-new' }],
              seo: { canonical: '/promo-new' },
            },
            {
              contentType: 'landingPage',
              id: 'old',
              lastModified: '2026-05-20T12:00:00.000Z',
              publishedLocales: [{ locale: 'en-US', path: '/promo-old' }],
              seo: { canonical: '/promo-new' },
            },
          ],
        },
        schemas: [
          { contentType: 'landingPage', fields: [{ name: 'path' }] },
        ],
      },
    })
    await generateContentPlatformRoutes(context, next)

    const { vbase } = context.clients
    const index = await vbase.getJSON<SitemapIndex>(
      bucketFor('1'),
      CONTENT_PLATFORM_ROUTES_INDEX,
      true
    )
    const entries = await Promise.all(
      index.index.map(file =>
        vbase.getJSON<SitemapEntry>(bucketFor('1'), file, true)
      )
    )
    expect(collectPaths(entries)).toEqual(['/promo-new'])
  })

  it('excludes login/error pages declared via schema classification or entry flag (FR-3)', async () => {
    const context = buildContext({
      dataPlane: {
        entriesByType: {
          landingPage: [
            {
              contentType: 'landingPage',
              id: 'keep',
              lastModified: '2026-05-20T12:00:00.000Z',
              publishedLocales: [{ locale: 'en-US', path: '/keep' }],
            },
            {
              contentType: 'landingPage',
              id: 'login-flagged',
              lastModified: '2026-05-20T12:00:00.000Z',
              loginOrErrorPage: true,
              publishedLocales: [{ locale: 'en-US', path: '/account/login' }],
            },
          ],
          login: [
            {
              contentType: 'login',
              id: 'login-typed',
              lastModified: '2026-05-20T12:00:00.000Z',
              publishedLocales: [{ locale: 'en-US', path: '/sign-in' }],
            },
          ],
        },
        schemas: [
          { contentType: 'landingPage', fields: [{ name: 'path' }] },
          {
            classification: 'login',
            contentType: 'login',
            fields: [{ name: 'path' }],
          },
        ],
      },
    })
    await generateContentPlatformRoutes(context, next)

    const { vbase } = context.clients
    const index = await vbase.getJSON<SitemapIndex>(
      bucketFor('1'),
      CONTENT_PLATFORM_ROUTES_INDEX,
      true
    )
    const entries = await Promise.all(
      index.index.map(file =>
        vbase.getJSON<SitemapEntry>(bucketFor('1'), file, true)
      )
    )
    expect(collectPaths(entries)).toEqual(['/keep'])
  })

  it('emits one URL per actually-published locale and groups alternates from real publications (US-3 locale fidelity — Decision 11)', async () => {
    const context = buildContext({
      dataPlane: {
        entriesByType: {
          landingPage: [
            {
              contentType: 'landingPage',
              id: 'lp-1',
              lastModified: '2026-05-20T12:00:00.000Z',
              publishedLocales: [
                { locale: 'en-US', path: '/about' },
                { locale: 'pt-BR', path: '/sobre' },
              ],
            },
          ],
        },
        schemas: [
          { contentType: 'landingPage', fields: [{ name: 'path' }] },
        ],
      },
    })

    await generateContentPlatformRoutes(context, next)

    const { vbase } = context.clients
    const indexEn = await vbase.getJSON<SitemapIndex>(
      bucketFor('1'),
      CONTENT_PLATFORM_ROUTES_INDEX,
      true
    )
    const indexPt = await vbase.getJSON<SitemapIndex>(
      bucketFor('2'),
      CONTENT_PLATFORM_ROUTES_INDEX,
      true
    )
    const enEntry = await vbase.getJSON<SitemapEntry>(
      bucketFor('1'),
      indexEn.index[0],
      true
    )
    const ptEntry = await vbase.getJSON<SitemapEntry>(
      bucketFor('2'),
      indexPt.index[0],
      true
    )
    expect(enEntry.routes[0].alternates).toEqual([
      { bindingId: '1', path: '/about' },
      { bindingId: '2', path: '/sobre' },
    ])
    expect(ptEntry.routes[0].alternates).toEqual([
      { bindingId: '1', path: '/about' },
      { bindingId: '2', path: '/sobre' },
    ])
  })

  it('does NOT synthesize alternates for locales served only by runtime fallback (Decision 11 / invariant 14)', async () => {
    const context = buildContext({
      dataPlane: {
        entriesByType: {
          landingPage: [
            {
              contentType: 'landingPage',
              id: 'lp-en-only',
              lastModified: '2026-05-20T12:00:00.000Z',
              publishedLocales: [{ locale: 'en-US', path: '/about' }],
            },
          ],
        },
        schemas: [
          { contentType: 'landingPage', fields: [{ name: 'path' }] },
        ],
      },
    })
    await generateContentPlatformRoutes(context, next)

    const { vbase } = context.clients
    const indexEn = await vbase.getJSON<SitemapIndex>(
      bucketFor('1'),
      CONTENT_PLATFORM_ROUTES_INDEX,
      true
    )
    const indexPt = await vbase.getJSON<SitemapIndex>(
      bucketFor('2'),
      CONTENT_PLATFORM_ROUTES_INDEX,
      true
    )
    expect(indexPt).toBeNull()
    const enEntry = await vbase.getJSON<SitemapEntry>(
      bucketFor('1'),
      indexEn.index[0],
      true
    )
    expect(enEntry.routes[0].alternates).toEqual([
      { bindingId: '1', path: '/about' },
    ])
  })

  it('honors disableRoutesTerm by filtering out matching substrings (consistency with hCMS source)', async () => {
    const context = buildContext({
      dataPlane: {
        entriesByType: {
          landingPage: [
            {
              contentType: 'landingPage',
              id: 'keep',
              lastModified: '2026-05-20T12:00:00.000Z',
              publishedLocales: [{ locale: 'en-US', path: '/keep' }],
            },
            {
              contentType: 'landingPage',
              id: 'hidden',
              lastModified: '2026-05-20T12:00:00.000Z',
              publishedLocales: [
                { locale: 'en-US', path: '/internal/staging-only' },
              ],
            },
          ],
        },
        schemas: [
          { contentType: 'landingPage', fields: [{ name: 'path' }] },
        ],
      },
      disableRoutesTerm: '/internal/',
    })

    await generateContentPlatformRoutes(context, next)

    const { vbase } = context.clients
    const index = await vbase.getJSON<SitemapIndex>(
      bucketFor('1'),
      CONTENT_PLATFORM_ROUTES_INDEX,
      true
    )
    const entries = await Promise.all(
      index.index.map(file =>
        vbase.getJSON<SitemapEntry>(bucketFor('1'), file, true)
      )
    )
    expect(collectPaths(entries)).toEqual(['/keep'])
  })

  it('skips generation entirely when enableContentPlatformRoutes is off (invariant 9 — settings gating)', async () => {
    const context = buildContext({
      dataPlane: {
        entriesByType: {
          landingPage: [
            {
              contentType: 'landingPage',
              id: 'lp-1',
              lastModified: '2026-05-20T12:00:00.000Z',
              publishedLocales: [{ locale: 'en-US', path: '/our-story' }],
            },
          ],
        },
        schemas: [
          { contentType: 'landingPage', fields: [{ name: 'path' }] },
        ],
      },
      enableContentPlatformRoutes: false,
    })

    await generateContentPlatformRoutes(context, next)
    expect(next).toBeCalled()
    // Data Plane is never called.
    expect((context as any).__listEntriesCalls()).toBe(0)

    const { vbase } = context.clients
    const index = await vbase.getJSON<SitemapIndex>(
      bucketFor('1'),
      CONTENT_PLATFORM_ROUTES_INDEX,
      true
    )
    expect(index).toBeNull()
  })

  it('emits cms-routes-ignored-by-mutual-exclusivity once per generation when both flags are on (US-6 / Decision 8)', async () => {
    const context = buildContext({
      dataPlane: {
        entriesByType: {
          landingPage: [
            {
              contentType: 'landingPage',
              id: 'lp-1',
              lastModified: '2026-05-20T12:00:00.000Z',
              publishedLocales: [{ locale: 'en-US', path: '/our-story' }],
            },
          ],
        },
        schemas: [
          { contentType: 'landingPage', fields: [{ name: 'path' }] },
        ],
      },
      enableCmsRoutes: true,
      enableContentPlatformRoutes: true,
    })

    await generateContentPlatformRoutes(context, next)

    const logger = (context as any).__logger as LoggerCapture
    const mutexCalls = logger.info.mock.calls.filter(
      call => call[0]?.type === 'cms-routes-ignored-by-mutual-exclusivity'
    )
    expect(mutexCalls.length).toBe(1)
  })

  it('short-circuits on ETag 304 for every routable type and preserves prior VBase entries (invariant 13)', async () => {
    const cpBucket = bucketFor('1')
    const existingEntry: SitemapEntry = {
      lastUpdated: '2026-01-01T00:00:00.000Z',
      routes: [
        {
          changefreq: 'weekly',
          id: 'landingPage:lp-1:1',
          path: '/preserved',
          priority: 0.5,
          source: 'content-platform',
        },
      ],
    }
    const existingIndex: SitemapIndex = {
      index: ['content-platform-routes-0'],
      lastUpdated: '2026-01-01T00:00:00.000Z',
    }
    const context = buildContext({
      dataPlane: {
        entriesByType: { landingPage: [] },
        entriesEtagByType: { landingPage: 'etag-prev' },
        notModifiedTypes: new Set(['landingPage']),
        schemas: [
          { contentType: 'landingPage', fields: [{ name: 'path' }] },
        ],
      },
      initialVbase: {
        [`${cpBucket}:${CONTENT_PLATFORM_ROUTES_INDEX}`]: existingIndex,
        [`${cpBucket}:content-platform-routes-0`]: existingEntry,
      },
    })

    await generateContentPlatformRoutes(context, next)

    const { vbase } = context.clients
    const index = await vbase.getJSON<SitemapIndex>(
      cpBucket,
      CONTENT_PLATFORM_ROUTES_INDEX,
      true
    )
    expect(index).toEqual(existingIndex)
    const entry = await vbase.getJSON<SitemapEntry>(
      cpBucket,
      'content-platform-routes-0',
      true
    )
    expect(entry).toEqual(existingEntry)
  })

  it('removes unpublished entries on next generation by overwriting the VBase index (US-1: unpublish/delete)', async () => {
    const cpBucket = bucketFor('1')
    const stale: SitemapEntry = {
      lastUpdated: '2026-01-01T00:00:00.000Z',
      routes: [
        {
          id: 'landingPage:lp-old:1',
          path: '/old',
          source: 'content-platform',
        },
      ],
    }
    const context = buildContext({
      dataPlane: {
        entriesByType: {
          landingPage: [
            {
              contentType: 'landingPage',
              id: 'lp-new',
              lastModified: '2026-05-20T12:00:00.000Z',
              publishedLocales: [{ locale: 'en-US', path: '/new' }],
            },
          ],
        },
        schemas: [
          { contentType: 'landingPage', fields: [{ name: 'path' }] },
        ],
      },
      initialVbase: {
        [`${cpBucket}:${CONTENT_PLATFORM_ROUTES_INDEX}`]: {
          index: ['content-platform-routes-0'],
          lastUpdated: '2026-01-01T00:00:00.000Z',
        },
        [`${cpBucket}:content-platform-routes-0`]: stale,
      },
    })

    await generateContentPlatformRoutes(context, next)

    const { vbase } = context.clients
    const index = await vbase.getJSON<SitemapIndex>(
      cpBucket,
      CONTENT_PLATFORM_ROUTES_INDEX,
      true
    )
    const entries = await Promise.all(
      index.index.map(file =>
        vbase.getJSON<SitemapEntry>(cpBucket, file, true)
      )
    )
    expect(collectPaths(entries)).toEqual(['/new'])
  })
})
