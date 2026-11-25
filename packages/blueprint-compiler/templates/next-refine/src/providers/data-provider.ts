import type { BaseKey, BaseRecord, CrudFilter, CrudSort, DataProvider, DeleteOneParams, GetListParams, GetManyParams, HttpError } from "@refinedev/core";

const base = "/api/v1";
const maxPageSize = 200;
const filterOperators = new Set(["eq", "ne", "lt", "lte", "gt", "gte", "contains", "startswith", "in", "null"]);

function segment(value: BaseKey): string {
  if (value === "" || value === "." || value === "..") throw new Error("Expected a resource name or record id");
  return encodeURIComponent(value);
}

function collection(resource: string): string {
  return base + "/" + segment(resource);
}

function item(resource: string, id: BaseKey): string {
  return collection(resource) + "/" + segment(id);
}

function scalar(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  throw new Error("Expected a string, number or boolean query value");
}

function filterValue({ operator, value }: CrudFilter): string {
  if (operator === "in") {
    if (!Array.isArray(value) || value.length === 0) throw new Error("Filter in requires an array of values");
    const values = value.map(scalar);
    if (values.some((entry) => entry === "" || entry.includes(","))) {
      throw new Error("Filter in cannot represent empty values or values containing commas");
    }
    return values.join(",");
  }
  return scalar(operator === "null" ? value ?? true : value);
}

function listTerms(search: URLSearchParams, sorters?: CrudSort[], filters?: CrudFilter[]): void {
  if (sorters?.length) {
    search.set("sort", sorters.map(({ field, order }) => (order === "desc" ? "-" : "") + field).join(","));
  }
  for (const filter of filters ?? []) {
    if (!("field" in filter) || !filterOperators.has(filter.operator)) {
      throw new Error("Unsupported API filter operator: " + filter.operator);
    }
    search.append("filter", filter.field + ":" + filter.operator + ":" + filterValue(filter));
  }
}

function withQuery(path: string, search: URLSearchParams): string {
  return search.size ? path + "?" + search.toString() : path;
}

function customUrl(value: string): URL {
  const url = value.trim();
  if (/^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith("//") || url.includes("\\")) {
    throw new Error("Use a same-origin path under " + base + " for custom requests");
  }
  const parsed = new URL(url, "http://trivia.local/");
  if (parsed.pathname === base || parsed.pathname.startsWith(base + "/")) return parsed;
  if (parsed.pathname.startsWith("/api/")) throw new Error("Use a path under " + base + " for custom requests");
  parsed.pathname = base + parsed.pathname;
  return parsed;
}

function addQuery(search: URLSearchParams, query: unknown): void {
  if (query == null) return;
  if (typeof query !== "object" || Array.isArray(query)) throw new Error("Expected a custom query object");
  for (const [key, value] of Object.entries(query)) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (entry != null) search.append(key, scalar(entry));
    }
  }
}

async function problemError(response: Response): Promise<HttpError> {
  const problem = await response.json().catch(() => null) as {
    title?: unknown;
    detail?: unknown;
    errors?: HttpError["errors"];
  } | null;
  const message = [problem?.detail, problem?.title, response.statusText]
    .find((text): text is string => typeof text === "string" && text.length > 0) ?? "HTTP " + response.status;
  return Object.assign(new Error(message), {
    statusCode: response.status,
    ...(problem?.errors && { errors: problem.errors }),
  });
}

export function createDataProvider(send: typeof fetch = globalThis.fetch): DataProvider {
  async function request<T>(url: string, method: string, body?: unknown, headers?: HeadersInit): Promise<T | undefined> {
    const init = new Headers(headers);
    if (body !== undefined && !init.has("content-type")) init.set("content-type", "application/json");
    const response = await send(url, {
      method,
      headers: init,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw await problemError(response);
    if (response.status === 204 || method === "HEAD") return undefined;
    return await response.json() as T;
  }

  async function record<T>(url: string, method: string, body?: unknown, headers?: HeadersInit): Promise<{ data: T }> {
    return { data: await request<T>(url, method, body, headers) as T };
  }

  async function getList<TData extends BaseRecord>({ resource, pagination, sorters, filters, meta }: GetListParams) {
    const search = new URLSearchParams();
    if (pagination?.currentPage !== undefined) search.set("page", String(pagination.currentPage));
    if (pagination?.pageSize !== undefined) search.set("pageSize", String(pagination.pageSize));
    listTerms(search, sorters, filters);
    const page = await request<{ items: TData[]; total: number }>(withQuery(collection(resource), search), "GET", undefined, meta?.headers);
    if (!page) throw new Error("The API did not return a page");
    return { data: page.items, total: page.total };
  }

  return {
    getApiUrl: () => base,
    getList,
    async getMany<TData extends BaseRecord>({ resource, ids, meta }: GetManyParams) {
      const pages = [];
      for (let offset = 0; offset < ids.length; offset += maxPageSize) {
        const batch = ids.slice(offset, offset + maxPageSize);
        pages.push(await getList<TData>({
          resource, meta, pagination: { currentPage: 1, pageSize: batch.length },
          filters: [{ field: "id", operator: "in", value: batch }],
        }));
      }
      return { data: pages.flatMap(({ data }) => data) };
    },
    getOne: ({ resource, id, meta }) => record(item(resource, id), "GET", undefined, meta?.headers),
    create: ({ resource, variables, meta }) => record(collection(resource), "POST", variables, meta?.headers),
    // PATCH changes only the members sent, so a form that edits some fields keeps the others.
    update: ({ resource, id, variables, meta }) => record(item(resource, id), "PATCH", variables, meta?.headers),
    async deleteOne<TData extends BaseRecord, TVariables>({ resource, id, variables, meta }: DeleteOneParams<TVariables>) {
      const data = await request<TData>(item(resource, id), "DELETE", variables, meta?.headers);
      return { data: data ?? { id } as TData };
    },
    custom: async ({ url, method, sorters, filters, payload, query, headers }) => {
      const target = customUrl(url);
      addQuery(target.searchParams, query);
      listTerms(target.searchParams, sorters, filters);
      return record(withQuery(target.pathname, target.searchParams), method.toUpperCase(), payload, headers);
    },
  };
}

export const dataProvider = createDataProvider();
