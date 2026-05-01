export type ApiOk<T> = { ok: true; data: T };
export type ApiError = { ok: false; error: { code: string; message: string } };
export type ApiResponse<T> = ApiOk<T> | ApiError;

export class ApiRequestError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code = "HTTP_ERROR") {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers:
      body === undefined
        ? { accept: "application/json" }
        : { accept: "application/json", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await response.text();
  const payload = text ? ((JSON.parse(text) as ApiResponse<T>) ?? null) : null;

  if (!response.ok) {
    if (payload && !payload.ok) {
      throw new ApiRequestError(payload.error.message, response.status, payload.error.code);
    }

    throw new ApiRequestError(`Request failed with status ${response.status}.`, response.status);
  }

  if (!payload) {
    return undefined as T;
  }

  if (!payload.ok) {
    throw new ApiRequestError(payload.error.message, response.status, payload.error.code);
  }

  return payload.data;
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>("GET", path);
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>("POST", path, body);
}

export function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return request<T>("PATCH", path, body);
}

export function apiPut<T>(path: string, body: unknown): Promise<T> {
  return request<T>("PUT", path, body);
}

export function apiDelete<T>(path: string, body?: unknown): Promise<T> {
  return request<T>("DELETE", path, body);
}
