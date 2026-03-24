export type ParsedAuthorizationCallback = {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
  url: string;
};

export function parseAuthorizationCallbackUrl(input: string): ParsedAuthorizationCallback {
  const url = new URL(input);

  return {
    url: url.toString(),
    code: url.searchParams.get("code") ?? undefined,
    state: url.searchParams.get("state") ?? undefined,
    error: url.searchParams.get("error") ?? undefined,
    errorDescription: url.searchParams.get("error_description") ?? undefined,
  };
}
