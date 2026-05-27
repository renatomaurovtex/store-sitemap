import { Binding } from '@vtex/api'

import {
  CmsContentTypeSchema,
  CmsEntry,
  CmsEntryLocalePublication,
  CmsSchemaField,
  CmsSeoFields,
} from '../../clients/cmsDataPlane'
import { resolveActiveCmsSource } from '../../services/routes'
import {
  CONTENT_PLATFORM_ROUTES_MAX_BYTES_PER_FILE,
  CONTENT_PLATFORM_ROUTES_MAX_URLS_PER_FILE,
  CONTENT_PLATFORM_ROUTES_PREFIX,
  getBucket,
  hashString,
  TENANT_CACHE_TTL_S,
} from '../../utils'
import {
  CONTENT_PLATFORM_ROUTES_INDEX,
  createFileName,
  currentDate,
  SitemapEntry,
  SitemapIndex,
} from './utils'

/**
 * Default field name that flags a content type as routable per spec
 * Decision 9. Stores may override per-schema via `slugFieldName`.
 */
const DEFAULT_SLUG_FIELD_NAME = 'path'

/**
 * Content types whose URLs are produced by the catalog pipelines
 * (`generateProductRoutes` / `generateRewriterRoutes`). The Content Platform
 * entries for these types are templates, not addressable URLs, so they are
 * excluded from this ingestion regardless of a declared `path` field
 * (spec Decision 9 / FR-9 / invariant 12).
 */
const CATALOG_OWNED_CLASSIFICATIONS = new Set(['pdp', 'plp', 'search'])

/**
 * Classifications that map to FR-3 mandatory exclusions on the Content
 * Platform side. Combined with the entry-level `loginOrErrorPage` flag, this
 * covers login / error surfaces declared via the schema.
 */
const SYSTEM_PAGE_CLASSIFICATIONS = new Set(['login', 'error'])

/**
 * Defaults applied to every Content Platform URL (FR-5). The CMS may
 * override `lastmod` per entry; `changefreq` and `priority` are stable
 * platform-wide unless we surface per-schema configuration later.
 */
export const CONTENT_PLATFORM_DEFAULT_CHANGEFREQ: ChangeFreq = 'weekly'
export const CONTENT_PLATFORM_DEFAULT_PRIORITY = 0.5

export const slugFieldNameFor = (schema: CmsContentTypeSchema): string =>
  schema.slugFieldName?.trim() || DEFAULT_SLUG_FIELD_NAME

const hasField = (fields: CmsSchemaField[] | undefined, name: string): boolean =>
  Array.isArray(fields) && fields.some(field => field?.name === name)

/**
 * Decide whether a content-type schema is routable for sitemap purposes.
 * Routable = declares a slug field AND is not owned by the catalog
 * pipelines AND is not a system surface (login / error). This is the only
 * gate — no type-name allowlists are used (spec Decision 9).
 */
export const isRoutableSchema = (schema: CmsContentTypeSchema): boolean => {
  if (!schema?.contentType) {
    return false
  }
  if (schema.classification && CATALOG_OWNED_CLASSIFICATIONS.has(schema.classification)) {
    return false
  }
  if (schema.classification && SYSTEM_PAGE_CLASSIFICATIONS.has(schema.classification)) {
    return false
  }
  return hasField(schema.fields, slugFieldNameFor(schema))
}

const isExcludedBySeo = (path: string, seo: CmsSeoFields | undefined): boolean => {
  if (!seo) {
    return false
  }
  if (seo.noindex === true) {
    return true
  }
  if (seo.canonical && seo.canonical !== path) {
    return true
  }
  return false
}

const isExcludedByClassification = (entry: CmsEntry, schema: CmsContentTypeSchema): boolean => {
  if (entry.loginOrErrorPage === true) {
    return true
  }
  if (
    schema.classification &&
    SYSTEM_PAGE_CLASSIFICATIONS.has(schema.classification)
  ) {
    return true
  }
  return false
}

const matchesDisableRoutesTerm = (path: string, term: string): boolean =>
  Boolean(term) && path.includes(term)

interface EntryRouteCandidate {
  bindingId: string
  publication: CmsEntryLocalePublication
}

/**
 * Map every published locale of an entry to a (binding, path) tuple. Each
 * Content Platform locale is matched to the store binding whose
 * `defaultLocale` equals it (case-insensitive). Locales without a matching
 * binding are silently skipped — sitemaps describe the surface served by
 * the store, not the CMS's own publication universe.
 */
const matchPublicationsToBindings = (
  entry: CmsEntry,
  bindings: Binding[]
): EntryRouteCandidate[] => {
  const candidates: EntryRouteCandidate[] = []
  for (const publication of entry.publishedLocales ?? []) {
    if (!publication?.path) {
      continue
    }
    const matchingBinding = bindings.find(
      binding =>
        binding.defaultLocale?.toLowerCase() === publication.locale?.toLowerCase()
    )
    if (!matchingBinding) {
      continue
    }
    candidates.push({ bindingId: matchingBinding.id, publication })
  }
  return candidates
}

interface BuildRouteArgs {
  entry: CmsEntry
  candidate: EntryRouteCandidate
  alternates: AlternateRoute[]
}

const toRoute = ({ entry, candidate, alternates }: BuildRouteArgs): Route => ({
  alternates,
  changefreq: CONTENT_PLATFORM_DEFAULT_CHANGEFREQ,
  id: `${entry.contentType}:${entry.id}:${candidate.bindingId}`,
  lastmod: entry.lastModified,
  path: candidate.publication.path,
  priority: CONTENT_PLATFORM_DEFAULT_PRIORITY,
  source: 'content-platform',
})

const estimateRouteBytes = (route: Route): number => JSON.stringify(route).length

interface ChunkAccumulator {
  chunks: Route[][]
  current: Route[]
  currentBytes: number
}

const newAccumulator = (): ChunkAccumulator => ({
  chunks: [],
  current: [],
  currentBytes: 0,
})

const pushRoute = (acc: ChunkAccumulator, route: Route) => {
  const routeBytes = estimateRouteBytes(route)
  const wouldExceedUrls = acc.current.length >= CONTENT_PLATFORM_ROUTES_MAX_URLS_PER_FILE
  const wouldExceedBytes =
    acc.current.length > 0 &&
    acc.currentBytes + routeBytes > CONTENT_PLATFORM_ROUTES_MAX_BYTES_PER_FILE
  if (wouldExceedUrls || wouldExceedBytes) {
    acc.chunks.push(acc.current)
    acc.current = []
    acc.currentBytes = 0
  }
  acc.current.push(route)
  acc.currentBytes += routeBytes
}

const flushAccumulator = (acc: ChunkAccumulator): Route[][] => {
  if (acc.current.length > 0) {
    acc.chunks.push(acc.current)
    acc.current = []
    acc.currentBytes = 0
  }
  return acc.chunks
}

interface EntryFilterContext {
  disableRoutesTerm: string
  schema: CmsContentTypeSchema
}

/**
 * Per-entry filter applied before bucketing (FR-3 + spec Decision 10 +
 * `disableRoutesTerm`). Each `<url>` candidate is checked independently so
 * an entry that has a canonical override on one locale but not another is
 * filtered correctly per locale.
 */
const isEligibleEntryRoute = (
  entry: CmsEntry,
  candidate: EntryRouteCandidate,
  filterCtx: EntryFilterContext
): boolean => {
  const { schema, disableRoutesTerm } = filterCtx
  const path = candidate.publication.path
  if (!path) {
    return false
  }
  if (isExcludedByClassification(entry, schema)) {
    return false
  }
  if (isExcludedBySeo(path, entry.seo)) {
    return false
  }
  if (matchesDisableRoutesTerm(path, disableRoutesTerm)) {
    return false
  }
  return true
}

interface BindingsForBindingId {
  byId: Map<string, Route[]>
}

const indexEntriesByBinding = (
  candidates: Array<{
    entry: CmsEntry
    candidate: EntryRouteCandidate
  }>
): BindingsForBindingId => {
  // Group by entry id first so that all matching locales of the same entry
  // share the same `alternates` array — required by URLEntry's xhtml:link
  // emission (spec Decision 5 + invariant 5).
  const byEntry = new Map<
    string,
    Array<{ entry: CmsEntry; candidate: EntryRouteCandidate }>
  >()
  for (const item of candidates) {
    const key = `${item.entry.contentType}:${item.entry.id}`
    const group = byEntry.get(key) ?? []
    group.push(item)
    byEntry.set(key, group)
  }

  const byId = new Map<string, Route[]>()
  for (const group of byEntry.values()) {
    const alternates: AlternateRoute[] = group.map(({ candidate }) => ({
      bindingId: candidate.bindingId,
      path: candidate.publication.path,
    }))
    for (const { entry, candidate } of group) {
      const route = toRoute({ entry, candidate, alternates })
      const bucket = byId.get(candidate.bindingId) ?? []
      bucket.push(route)
      byId.set(candidate.bindingId, bucket)
    }
  }
  return { byId }
}

const saveBindingChunks = async (
  ctx: Context | EventContext,
  bindingId: string,
  routes: Route[]
) => {
  const {
    clients: { vbase },
  } = ctx
  const bucket = getBucket(CONTENT_PLATFORM_ROUTES_PREFIX, hashString(bindingId))
  const acc = newAccumulator()
  for (const route of routes) {
    pushRoute(acc, route)
  }
  const chunks = flushAccumulator(acc)
  const lastUpdated = currentDate()
  const fileNames: string[] = []
  // Sequential writes keep order predictable across runs (determinism per
  // invariant 6).
  for (let i = 0; i < chunks.length; i += 1) {
    const fileName = createFileName(CONTENT_PLATFORM_ROUTES_PREFIX, i)
    // eslint-disable-next-line no-await-in-loop
    await vbase.saveJSON<SitemapEntry>(bucket, fileName, {
      lastUpdated,
      routes: chunks[i],
    })
    fileNames.push(fileName)
  }
  await vbase.saveJSON<SitemapIndex>(bucket, CONTENT_PLATFORM_ROUTES_INDEX, {
    index: fileNames,
    lastUpdated,
  })
  return fileNames.length
}

/**
 * VBase bucket for tracking which routable Content Types we've already seen
 * across generations. A type appearing here is silent; a new one fires
 * `content-platform-new-routable-type` once and is then added (Decision 9 —
 * "new routable type is logged on first sight").
 */
const ROUTABLE_TYPE_HISTORY_BUCKET = `${CONTENT_PLATFORM_ROUTES_PREFIX}_history`
const ROUTABLE_TYPE_HISTORY_FILE = 'routable-types.json'

interface RoutableTypeHistory {
  contentTypes: string[]
}

interface SchemaEtagCache {
  etag?: string
}

const SCHEMA_ETAG_FILE = 'schemas-etag.json'

const ENTRIES_ETAG_BUCKET = `${CONTENT_PLATFORM_ROUTES_PREFIX}_etag`

interface EntryEtagCache {
  etag?: string
}

const entryEtagFile = (contentType: string) =>
  `entries-etag-${contentType.replace(/[^a-zA-Z0-9-_]/g, '_')}.json`

const logNewRoutableTypes = async (
  ctx: Context | EventContext,
  routableSchemas: CmsContentTypeSchema[]
) => {
  const {
    clients: { vbase },
    vtex: { logger },
  } = ctx
  const history = (await vbase.getJSON<RoutableTypeHistory>(
    ROUTABLE_TYPE_HISTORY_BUCKET,
    ROUTABLE_TYPE_HISTORY_FILE,
    true
  )) ?? { contentTypes: [] }
  const known = new Set(history.contentTypes)
  const fresh = routableSchemas
    .map(s => s.contentType)
    .filter(name => !known.has(name))
  if (fresh.length > 0) {
    for (const name of fresh) {
      logger.info({
        contentType: name,
        message: `Content Platform: new routable type discovered (${name})`,
        type: 'content-platform-new-routable-type',
      })
      known.add(name)
    }
    await vbase.saveJSON<RoutableTypeHistory>(
      ROUTABLE_TYPE_HISTORY_BUCKET,
      ROUTABLE_TYPE_HISTORY_FILE,
      { contentTypes: Array.from(known).sort() }
    )
  }
}

interface IngestSchemaResult {
  candidates: Array<{ entry: CmsEntry; candidate: EntryRouteCandidate }>
  hadEtagHit: boolean
}

const ingestSchema = async (
  ctx: Context | EventContext,
  schema: CmsContentTypeSchema,
  bindings: Binding[],
  branchId: string,
  disableRoutesTerm: string
): Promise<IngestSchemaResult> => {
  const {
    clients: { cmsDataPlane, vbase },
  } = ctx
  const etagFile = entryEtagFile(schema.contentType)
  const previous = await vbase.getJSON<EntryEtagCache>(
    ENTRIES_ETAG_BUCKET,
    etagFile,
    true
  )
  const response = await cmsDataPlane.listEntries({
    branch: branchId,
    contentType: schema.contentType,
    etag: previous?.etag,
  })
  if (response.notModified) {
    return { candidates: [], hadEtagHit: true }
  }
  if (response.etag && response.etag !== previous?.etag) {
    await vbase.saveJSON<EntryEtagCache>(ENTRIES_ETAG_BUCKET, etagFile, {
      etag: response.etag,
    })
  }
  const entries = response.data ?? []
  const filterCtx: EntryFilterContext = { disableRoutesTerm, schema }
  const candidates: Array<{ entry: CmsEntry; candidate: EntryRouteCandidate }> = []
  for (const entry of entries) {
    const matches = matchPublicationsToBindings(entry, bindings)
    for (const candidate of matches) {
      if (isEligibleEntryRoute(entry, candidate, filterCtx)) {
        candidates.push({ candidate, entry })
      }
    }
  }
  return { candidates, hadEtagHit: false }
}

interface MutualExclusivityArgs {
  enableCmsRoutes: boolean
  enableContentPlatformRoutes: boolean
}

const emitMutualExclusivityLogIfNeeded = (
  ctx: Context | EventContext,
  { enableCmsRoutes, enableContentPlatformRoutes }: MutualExclusivityArgs
) => {
  if (enableCmsRoutes && enableContentPlatformRoutes) {
    ctx.vtex.logger.info({
      message:
        'Both enableCmsRoutes and enableContentPlatformRoutes are on; Content Platform wins per Decision 8',
      type: 'cms-routes-ignored-by-mutual-exclusivity',
    })
  }
}

/**
 * Read the store bindings and surface them via the existing tenant cache.
 * Content Platform locales are matched to bindings via `defaultLocale`
 * (case-insensitive); only store-targeted bindings participate.
 */
const fetchStoreBindings = async (ctx: Context | EventContext): Promise<Binding[]> => {
  const {
    clients: { tenant },
  } = ctx
  const tenantInfo = await tenant.info({
    forceMaxAge: TENANT_CACHE_TTL_S,
  })
  return (tenantInfo.bindings ?? []).filter(
    b => b.targetProduct === 'vtex-storefront'
  )
}

const resolveBranch = async (ctx: Context | EventContext): Promise<string> => {
  const {
    clients: { cmsDataPlane },
    vtex: { logger },
  } = ctx
  const branch = await cmsDataPlane.resolveProductionBranch()
  logger.info({
    branchId: branch.id,
    message: `Content Platform: resolved production branch ${branch.id}`,
    type: 'content-platform-branch-resolved',
  })
  return branch.id
}

const loadSchemas = async (
  ctx: Context | EventContext,
  branchId: string
): Promise<CmsContentTypeSchema[]> => {
  const {
    clients: { cmsDataPlane, vbase },
  } = ctx
  const previousEtag = await vbase.getJSON<SchemaEtagCache>(
    ENTRIES_ETAG_BUCKET,
    SCHEMA_ETAG_FILE,
    true
  )
  const response = await cmsDataPlane.listSchemas({
    branch: branchId,
    etag: previousEtag?.etag,
  })
  if (response.etag && response.etag !== previousEtag?.etag) {
    await vbase.saveJSON<SchemaEtagCache>(ENTRIES_ETAG_BUCKET, SCHEMA_ETAG_FILE, {
      etag: response.etag,
    })
  }
  return response.data ?? []
}

/**
 * Ingest Content Platform routes for every store binding and persist them
 * to VBase under `content-platform-routes_*`. Wires together the Data
 * Plane, the schema-driven discovery rule (Decision 9), the SEO opt-out
 * rule (Decision 10) and the per-locale emission rule (Decision 11).
 *
 * Mutually exclusive with `generateCmsRoutes` (Decision 8 / FR-10): when
 * `enableContentPlatformRoutes` is off this middleware short-circuits and
 * leaves prior VBase entries untouched. When both flags are on a one-shot
 * `cms-routes-ignored-by-mutual-exclusivity` log is emitted (informational
 * — the hCMS skip itself happens in `generateCmsRoutes`).
 */
export async function generateContentPlatformRoutes(
  ctx: Context | EventContext,
  next?: () => Promise<void>
) {
  const {
    state: { settings },
    vtex: { logger },
  } = ctx

  const activeSource = resolveActiveCmsSource(settings)
  emitMutualExclusivityLogIfNeeded(ctx, {
    enableCmsRoutes: Boolean(settings?.enableCmsRoutes),
    enableContentPlatformRoutes: Boolean(settings?.enableContentPlatformRoutes),
  })

  if (activeSource !== 'content-platform') {
    logger.info({
      activeSource,
      message:
        'Content Platform routes generation skipped: source is not active',
      type: 'content-platform-routes-generation-skipped',
    })
    if (next) {
      await next()
    }
    return
  }

  const disableRoutesTerm = settings.disableRoutesTerm || ''
  const startTime = Date.now()
  logger.info({
    message: 'Content Platform routes generation started',
    type: 'content-platform-routes-generation-start',
  })

  try {
    const bindings = await fetchStoreBindings(ctx)
    const branchId = await resolveBranch(ctx)
    const schemas = await loadSchemas(ctx, branchId)
    const routableSchemas = schemas.filter(isRoutableSchema)
    await logNewRoutableTypes(ctx, routableSchemas)

    const allCandidates: Array<{ entry: CmsEntry; candidate: EntryRouteCandidate }> = []
    let etagHits = 0
    const perTypeCounts: Record<string, number> = {}
    for (const schema of routableSchemas) {
      // eslint-disable-next-line no-await-in-loop
      const { candidates, hadEtagHit } = await ingestSchema(
        ctx,
        schema,
        bindings,
        branchId,
        disableRoutesTerm
      )
      if (hadEtagHit) {
        etagHits += 1
        continue
      }
      perTypeCounts[schema.contentType] = candidates.length
      allCandidates.push(...candidates)
    }

    // If every schema short-circuited via ETag, preserve the previous
    // VBase entries verbatim (invariant 13). The generator returns
    // without rewriting anything.
    if (allCandidates.length === 0 && etagHits === routableSchemas.length && routableSchemas.length > 0) {
      logger.info({
        etagHits,
        message:
          'Content Platform routes: every schema short-circuited via ETag — VBase entries preserved',
        type: 'content-platform-routes-etag-short-circuit',
      })
      if (next) {
        await next()
      }
      return
    }

    const { byId } = indexEntriesByBinding(allCandidates)
    const bindingIds = Array.from(byId.keys())
    const fileCounts = await Promise.all(
      bindingIds.map(bindingId =>
        saveBindingChunks(ctx, bindingId, byId.get(bindingId)!)
      )
    )

    const totalRoutes = Array.from(byId.values()).reduce(
      (sum, routes) => sum + routes.length,
      0
    )
    const totalFiles = fileCounts.reduce((sum, n) => sum + n, 0)

    logger.info({
      bindings: bindingIds.length,
      branch: branchId,
      durationMs: Date.now() - startTime,
      etagHitRatio: routableSchemas.length > 0 ? etagHits / routableSchemas.length : 0,
      message: 'Content Platform routes generation complete',
      perTypeCounts,
      totalFiles,
      totalRoutes,
      type: 'content-platform-routes-generation-success',
    })
  } catch (error) {
    logger.error({
      error,
      message: 'Content Platform routes generation failed',
      type: 'content-platform-routes-generation-error',
    })
    throw error
  } finally {
    if (next) {
      await next()
    }
  }
}
