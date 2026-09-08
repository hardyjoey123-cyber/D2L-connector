import type { Config } from "./config.js";
import { authenticateRequest } from "./auth.js";

interface ProductVersions {
  ProductCode: string;
  LatestVersion: string;
  SupportedVersions: string[];
}

/** Thrown for non-2xx responses from Brightspace, carrying status for callers to inspect. */
export class D2LApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly url: string,
    public readonly body: string
  ) {
    super(
      `Brightspace API request failed: ${status} ${statusText} for ${url}${
        body ? ` — ${body}` : ""
      }`
    );
    this.name = "D2LApiError";
  }
}

export class D2LClient {
  private versionCache: Map<string, string> = new Map();

  constructor(private readonly config: Config) {}

  private buildUrl(path: string, query?: Record<string, string | number | undefined>): URL {
    const url = new URL(path.replace(/^\/?/, "/"), this.config.domain);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  /** Low-level authenticated request. `path` is the URL path (no query string). */
  async request<T>(
    method: string,
    path: string,
    query?: Record<string, string | number | undefined>
  ): Promise<T> {
    const url = this.buildUrl(path, query);
    const auth = await authenticateRequest(this.config, method, `${url.origin}${url.pathname}`);

    for (const [key, value] of Object.entries(auth.query)) {
      url.searchParams.set(key, value);
    }

    const response = await fetch(url.toString(), {
      method,
      headers: {
        Accept: "application/json",
        ...auth.headers,
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new D2LApiError(response.status, response.statusText, url.toString(), body);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  /**
   * Resolves the highest Brightspace API version supported for a given product
   * ("lp" = Learning Platform, "le" = Learning Environment) by calling the
   * public, unauthenticated /d2l/api/versions/ endpoint and caching the result.
   */
  async resolveVersion(productCode: "lp" | "le"): Promise<string> {
    const override =
      productCode === "lp"
        ? process.env.BRIGHTSPACE_LP_VERSION
        : process.env.BRIGHTSPACE_LE_VERSION;
    if (override) return override;

    const cached = this.versionCache.get(productCode);
    if (cached) return cached;

    const all = await this.request<ProductVersions[]>("GET", "/d2l/api/versions/");
    const product = all.find((p) => p.ProductCode.toLowerCase() === productCode);
    if (!product) {
      throw new Error(
        `Brightspace instance did not report a supported version for product "${productCode}".`
      );
    }
    this.versionCache.set(productCode, product.LatestVersion);
    return product.LatestVersion;
  }

  async lpGet<T>(
    pathSuffix: string,
    query?: Record<string, string | number | undefined>
  ): Promise<T> {
    const version = await this.resolveVersion("lp");
    return this.request<T>("GET", `/d2l/api/lp/${version}${pathSuffix}`, query);
  }

  async leGet<T>(
    pathSuffix: string,
    query?: Record<string, string | number | undefined>
  ): Promise<T> {
    const version = await this.resolveVersion("le");
    return this.request<T>("GET", `/d2l/api/le/${version}${pathSuffix}`, query);
  }

  /**
   * Follows Brightspace's bookmark-based pagination
   * ({ Items, PagingInfo: { Bookmark, HasMoreItems } }) until exhausted or
   * `maxItems` is reached, returning the flattened item list.
   */
  async paginateLp<TItem>(
    pathSuffix: string,
    query: Record<string, string | number | undefined> = {},
    maxItems = 500
  ): Promise<TItem[]> {
    const version = await this.resolveVersion("lp");
    return this.paginate<TItem>(`/d2l/api/lp/${version}${pathSuffix}`, query, maxItems);
  }

  private async paginate<TItem>(
    path: string,
    query: Record<string, string | number | undefined>,
    maxItems: number
  ): Promise<TItem[]> {
    const items: TItem[] = [];
    let bookmark: string | undefined;

    do {
      const page = await this.request<{
        Items: TItem[];
        PagingInfo: { Bookmark: string | null; HasMoreItems: boolean };
      }>("GET", path, { ...query, bookmark });

      items.push(...page.Items);
      bookmark = page.PagingInfo.HasMoreItems ? page.PagingInfo.Bookmark ?? undefined : undefined;
    } while (bookmark && items.length < maxItems);

    return items.slice(0, maxItems);
  }
}
