import createClient from 'openapi-fetch';
import type { ClientOptions } from 'openapi-fetch';

/** Pass the generated `paths` type to bind each method, path, query and body. */
export function createTypedApiClient<Paths extends Record<string, unknown>>(
  baseUrl: string,
  options: Omit<ClientOptions, 'baseUrl'> = {},
) {
  return createClient<Paths>({ baseUrl, ...options });
}
