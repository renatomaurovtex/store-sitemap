import { ExternalClient, InstanceOptions, IOContext } from '@vtex/api'

/**
 * Read-only client for the VTEX CMS (Content Platform) Data Plane REST API.
 *
 * Per spec Decision 7 and Decision 9 the generator needs three primitives:
 *
 *   1. Resolve which branch is the store's production branch (we pin all
 *      reads to it — preview / draft / feature branches are never queried).
 *   2. List the registered content-type schemas so we can find the ones that
 *      declare a `path` field (schema-driven discovery).
 *   3. For each routable schema, list its published entries with their SEO
 *      fields and locale-keyed published paths.
 *
 * ETag short-circuiting (spec invariant 13): every list call accepts an
 * optional `etag` and returns a `notModified` flag when the Data Plane
 * answers `304 Not Modified`. The generator uses that flag to skip the VBase
 * rewrite and preserve the previous successful entry verbatim.
 *
 * Retries: the underlying `@vtex/api` ExternalClient already retries
 * transient transport-level failures based on `InstanceOptions`. On top of
 * that, this client implements a bounded exponential backoff for 5xx
 * responses (Data Plane is read-only and idempotent, so re-issuing GETs is
 * safe). Persistent failure surfaces as a thrown error which the caller
 * turns into a `content-platform-routes-generation-error` structured log.
 *
 * The Data Plane host is account-scoped (`{account}.myvtex.com`) and is
 * declared in `manifest.json` under `outbound-access`. The exact path layout
 * follows the CMS team's read-only endpoints; we use the
 * `/api/cms/data-plane/*` family which matches the policy declared in the
 * manifest. When the CMS team publishes a different layout, only the URL
 * builders below need to change — the call sites in
 * `generateContentPlatformRoutes` are agnostic.
 */

const DATA_PLANE_PATH = '/api/cms/data-plane'
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_RETRY_DELAY_MS = 1000

export interface CmsSchemaField {
  /** Schema field name as declared in the content type. */
  name: string
  type?: string
}

export interface CmsContentTypeSchema {
  /** Stable identifier of the content type (`landingPage`, `home`, etc.). */
  contentType: string
  /** Display name, useful for logs only. */
  title?: string
  /**
   * Field declarations from the schema. The generator's only requirement is
   * that we can detect whether the schema declares a routable field — by
   * default `path`, but the store can configure an alias under
   * `slugFieldName`. This is the surface that drives the schema-driven
   * discovery rule from spec Decision 9.
   */
  fields: CmsSchemaField[]
  /**
   * Store-configured override for the slug field name. Falls back to `path`
   * (the platform default) when absent.
   */
  slugFieldName?: string
  /**
   * Pre-classified intent of the schema. The generator excludes
   * `pdp` / `plp` / `search` from ingestion regardless of the `path` field
   * (Decision 9) because their URLs are owned by the catalog pipelines.
   */
  classification?: 'pdp' | 'plp' | 'search' | 'landing' | 'home' | 'custom' | 'login' | 'error'
}

export interface CmsSeoFields {
  noindex?: boolean
  canonical?: string
}

export interface CmsEntryLocalePublication {
  /** Locale as published by the CMS, e.g. `en-US`. */
  locale: string
  /** The URL slug for this locale (already URL-encoded by the CMS). */
  path: string
}

export interface CmsEntry {
  id: string
  contentType: string
  /** ISO timestamp of the last publish event. */
  lastModified: string
  /**
   * Locales where the entry has actually published content. The generator
   * never synthesizes locales from runtime fallback rules (spec Decision 11
   * / invariant 14).
   */
  publishedLocales: CmsEntryLocalePublication[]
  /** SEO fields from the entry. Drives opt-out per spec Decision 10. */
  seo?: CmsSeoFields
  /**
   * True when the entry's content type or the entry itself classifies the
   * page as a login / error surface. Drives mandatory exclusion (FR-3).
   */
  loginOrErrorPage?: boolean
}

export interface DataPlaneBranchInfo {
  /** Resolved identifier of the production branch, logged once per run. */
  id: string
}

export interface DataPlaneListResponse<T> {
  /** Response payload when fresh; undefined on 304 short-circuit. */
  data?: T
  /** Newest ETag returned by the Data Plane (kept for the next read). */
  etag?: string
  /** True when the server replied `304 Not Modified` for the given ETag. */
  notModified: boolean
}

export interface ListEntriesParams {
  contentType: string
  branch: string
  etag?: string
}

export interface ListSchemasParams {
  branch: string
  etag?: string
}

const sleep = (ms: number) =>
  new Promise<void>(resolve => {
    setTimeout(resolve, ms)
  })

const isRetriable5xx = (status: number | undefined): boolean =>
  typeof status === 'number' && status >= 500 && status < 600

const isNotModified = (status: number | undefined): boolean => status === 304

export class CmsDataPlane extends ExternalClient {
  constructor(context: IOContext, options?: InstanceOptions) {
    super(`http://${context.account}.myvtex.com`, context, {
      ...(options ?? {}),
      headers: {
        ...(options?.headers ?? {}),
        Accept: 'application/json',
        VtexIdclientAutCookie: context.authToken,
      },
    })
  }

  /**
   * Resolve the store's production branch identifier. The Data Plane is
   * expected to expose a stable alias (e.g., a literal "production" tag);
   * we keep this behind a method so the generator can log the resolved id
   * once per generation and so future CMS-side changes (e.g., promoting a
   * different tag name) only touch this client.
   */
  public resolveProductionBranch = async (): Promise<DataPlaneBranchInfo> => {
    const response = await this.getWithRetry<{ id?: string }>(
      `${DATA_PLANE_PATH}/branches/production`
    )
    return {
      id: response?.id ?? 'production',
    }
  }

  public listSchemas = async ({
    branch,
    etag,
  }: ListSchemasParams): Promise<DataPlaneListResponse<CmsContentTypeSchema[]>> =>
    this.getList<CmsContentTypeSchema[]>(
      `${DATA_PLANE_PATH}/schemas`,
      { branch },
      etag
    )

  public listEntries = async ({
    contentType,
    branch,
    etag,
  }: ListEntriesParams): Promise<DataPlaneListResponse<CmsEntry[]>> =>
    this.getList<CmsEntry[]>(
      `${DATA_PLANE_PATH}/entries`,
      { contentType, branch },
      etag
    )

  private async getList<T>(
    path: string,
    params: Record<string, string>,
    etag?: string
  ): Promise<DataPlaneListResponse<T>> {
    const headers: Record<string, string> = {}
    if (etag) {
      headers['If-None-Match'] = etag
    }

    let attempt = 0
    // We retry only on 5xx; 304 / 4xx / network errors propagate after the
    // last allowed attempt so the caller (generator) can fall back to the
    // previous successful VBase entry without regressing the served XML
    // (spec NFR — Reliability).
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const response = await this.http.getRaw<T>(path, {
          headers,
          metric: 'cms-data-plane-get-list',
          params,
          validateStatus: status => status === 200 || status === 304,
        })
        if (isNotModified(response.status)) {
          return { etag, notModified: true }
        }
        const newEtag =
          (response.headers?.etag as string | undefined) ?? etag
        return {
          data: response.data,
          etag: newEtag,
          notModified: false,
        }
      } catch (error) {
        const status = error?.response?.status as number | undefined
        if (isNotModified(status)) {
          return { etag, notModified: true }
        }
        if (!isRetriable5xx(status) || attempt >= DEFAULT_MAX_RETRIES) {
          throw error
        }
        attempt += 1
        await sleep(DEFAULT_RETRY_DELAY_MS * attempt)
      }
    }
  }

  private async getWithRetry<T>(path: string): Promise<T> {
    let attempt = 0
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await this.http.get<T>(path, {
          metric: 'cms-data-plane-get',
        })
      } catch (error) {
        const status = error?.response?.status as number | undefined
        if (!isRetriable5xx(status) || attempt >= DEFAULT_MAX_RETRIES) {
          throw error
        }
        attempt += 1
        await sleep(DEFAULT_RETRY_DELAY_MS * attempt)
      }
    }
  }
}
