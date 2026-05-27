import { Internal, ListInternalsResponse } from 'vtex.rewriter'
import { flatten } from 'ramda'

import { isValidCmsRoute } from '../middlewares/generateMiddlewares/generateCmsRoutes'
import {
  CONTENT_PLATFORM_ROUTES_INDEX,
  SitemapEntry,
  SitemapIndex,
} from '../middlewares/generateMiddlewares/utils'
import { Settings } from '../middlewares/settings'
import {
  CONTENT_PLATFORM_ROUTES_PREFIX,
  EXTENDED_INDEX_FILE,
  getBucket,
  hashString,
} from '../utils'

const STORE_SITEMAP_BUILD_FILE = '/dist/vtex.store-sitemap/build.json'

const LIST_LIMIT = 300
const MAX_PAGES = 50

const isValidRoute = (internalRoute: Internal) =>
  !internalRoute.disableSitemapEntry &&
  !internalRoute.type.startsWith('notFound') &&
  internalRoute.type !== 'product'

async function fetchInternalRoutes(ctx: Context, limit: number) {
  const {
    clients: { rewriter },
    vtex: { logger },
  } = ctx

  const internalRoutes = []
  let nextCursor
  let pageCount = 0

  do {
    pageCount++
    // eslint-disable-next-line no-await-in-loop
    const response: ListInternalsResponse = await rewriter.listInternalsWithRetry(
      limit,
      nextCursor
    )
    internalRoutes.push(...(response.routes?.filter(isValidRoute) ?? []))
    nextCursor = response.next

    if (pageCount >= MAX_PAGES && nextCursor) {
      logger.warn({
        message: 'Maximum page limit reached for internal routes',
        type: 'internal-routes-max-pages',
        pageCount,
        totalRoutes: internalRoutes.length,
        hasMorePages: true,
      })
      break
    }
  } while (nextCursor)

  return internalRoutes
}

async function fetchExtendedRoutes(ctx: Context) {
  const {
    state: { binding },
    clients: { vbase },
    vtex: { logger },
  } = ctx

  // Extended routes require a binding context
  if (!binding) {
    logger.info({
      message: 'Skipping extended routes fetch - no binding context available',
      type: 'extended-routes-skip',
    })
    return []
  }

  const extendedIndex = await vbase.getJSON<SitemapIndex>(
    getBucket('', hashString(binding.id)),
    EXTENDED_INDEX_FILE,
    true
  )

  const extendedEntries = extendedIndex?.index.map(
    entry => `/sitemap/${entry.replace(/^\//, '')}.xml`
  )

  return extendedEntries || []
}

export async function getUserRoutes(ctx: Context) {
  const [internalRoutes, extendedRoutes] = await Promise.all([
    fetchInternalRoutes(ctx, LIST_LIMIT),
    fetchExtendedRoutes(ctx),
  ])

  const validInternalRoutes = internalRoutes
    .filter(isValidRoute)
    .map(route => route.from)

  const userRoutes = [...validInternalRoutes, ...extendedRoutes]

  return userRoutes
}

export async function getAppsRoutes(ctx: Context) {
  const {
    clients: { apps },
  } = ctx

  const deps = await apps.getAppsMetaInfos()
  const routes = await Promise.all(
    deps.map(async dep => {
      const build = await apps.getAppJSON<{ entries: string[] }>(
        dep.id,
        STORE_SITEMAP_BUILD_FILE,
        true
      )

      return build?.entries || []
    })
  )

  return flatten<string>(routes)
}

/**
 * Resolve which CMS source produces emitted XML / JSON for this generation
 * (invariant 10 — single active CMS source / spec Decision 8).
 *
 * Rules:
 * - Both flags off → 'none' (the customRoutes response is the legacy 2-entry
 *   shape, no extra XML).
 * - Only `enableCmsRoutes` on → 'hcms'.
 * - Only `enableContentPlatformRoutes` on → 'content-platform'.
 * - Both flags on → 'content-platform' wins (Decision 8); hCMS ingestion is
 *   skipped and a `cms-routes-ignored-by-mutual-exclusivity` log is emitted
 *   elsewhere in the pipeline.
 */
export type ActiveCmsSource = 'hcms' | 'content-platform' | 'none'

export const resolveActiveCmsSource = (
  settings: Partial<Settings> | undefined
): ActiveCmsSource => {
  if (settings?.enableContentPlatformRoutes) {
    return 'content-platform'
  }
  if (settings?.enableCmsRoutes) {
    return 'hcms'
  }
  return 'none'
}

/**
 * Return the flat list of CMS-origin route paths that pass the CMS sitemap
 * filter. Mirrors `getUserRoutes` shape (paths across all bindings) so it can
 * be embedded directly in the `customRoutes` JSON cache.
 *
 * Filter logic is shared with `generateCmsRoutes` (the XML pipeline) via
 * `isValidCmsRoute`, keeping both views consistent (invariant 6 — determinism).
 *
 * Honors mutual exclusivity (spec Decision 8): when Content Platform wins
 * (its flag is on), this function returns `[]` even if `enableCmsRoutes` is
 * also true.
 */
export async function getCmsRoutes(ctx: Context): Promise<string[]> {
  const {
    state: { settings },
  } = ctx

  // When the rollout flag is off (or Content Platform wins by mutex) this
  // feature behaves as if it did not exist (invariant 9 — settings gating;
  // invariant 10 — single active source); skip the Rewriter calls entirely.
  if (resolveActiveCmsSource(settings) !== 'hcms') {
    return []
  }

  const disableRoutesTerm = settings.disableRoutesTerm || ''
  const internalRoutes = await fetchInternalRoutes(ctx, LIST_LIMIT)
  return internalRoutes
    .filter(internal => isValidCmsRoute(internal, disableRoutesTerm))
    .map(internal => internal.from)
}

/**
 * Return the flat list of Content Platform route paths persisted in VBase by
 * the `generateContentPlatformRoutes` middleware. Mirrors `getCmsRoutes`
 * shape (paths across all bindings) for embedding in the customRoutes JSON
 * cache.
 *
 * Reads from the dedicated `content-platform-routes_*` per-binding buckets
 * written by the generator (spec Decision 7). When the binding has no
 * persisted Content Platform routes (e.g., first generation has not yet
 * completed), returns an empty array — never throws.
 */
export async function getContentPlatformRoutes(ctx: Context): Promise<string[]> {
  const {
    state: { binding, settings },
    clients: { vbase },
  } = ctx

  if (resolveActiveCmsSource(settings) !== 'content-platform') {
    return []
  }
  if (!binding?.id) {
    return []
  }

  const bucket = getBucket(CONTENT_PLATFORM_ROUTES_PREFIX, hashString(binding.id))
  const index = await vbase.getJSON<SitemapIndex>(
    bucket,
    CONTENT_PLATFORM_ROUTES_INDEX,
    true
  )
  if (!index?.index?.length) {
    return []
  }

  const entries = await Promise.all(
    index.index.map(file => vbase.getJSON<SitemapEntry>(bucket, file, true))
  )
  return entries.reduce<string[]>((acc, entry) => {
    if (!entry?.routes) {
      return acc
    }
    for (const route of entry.routes) {
      acc.push(route.path)
    }
    return acc
  }, [])
}
