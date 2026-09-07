/**
 * Plain HTTP probe, used for `web` endpoints and for anything whose declared
 * kind the prober has no protocol handler for. A 2xx with a body is a pass; an
 * empty 2xx is recorded as reachable but not protocol-conformant, because "the
 * socket opened" is not a service.
 */

import { httpRequestWithRetry, isJsonContentType, looksLikeHtml } from './http.ts'
import type { HttpOptions } from './http.ts'
import { parseX402Challenge } from './x402.ts'
import type { ProtocolOutcome } from '../types.ts'

export async function probeWeb(endpoint: string, opts: HttpOptions = {}): Promise<ProtocolOutcome> {
  const res = await httpRequestWithRetry(endpoint, {
    ...opts,
    method: 'GET',
    headers: { accept: 'text/html, application/json;q=0.9, */*;q=0.5' },
  })

  if (!res.ok) {
    // A 402 with a real challenge is a paid endpoint behaving correctly, even
    // when the card never mentioned x402.
    if (res.status === 402 && res.headers !== null) {
      const parsed = parseX402Challenge({ status: res.status, headers: res.headers, body: res.text })
      if (parsed !== null) {
        return {
          ok: true,
          protocolOk: true,
          failure: null,
          detail: `HTTP 402 with an x402 v${parsed.challenge.x402Version} challenge (${parsed.source})`,
          status: res.status,
          latencyMs: res.latencyMs,
          requests: [res.trace],
          capabilities: { x402: parsed.challenge },
        }
      }
    }

    return {
      ok: false,
      protocolOk: false,
      failure: res.failure,
      detail: res.detail,
      status: res.status,
      latencyMs: res.latencyMs,
      requests: [res.trace],
      capabilities: {},
    }
  }

  const hasBody = res.bytes > 0
  const shape = looksLikeHtml(res.text, res.contentType) ? 'html' : isJsonContentType(res.contentType) ? 'json' : 'other'

  return {
    ok: true,
    protocolOk: hasBody,
    failure: null,
    detail: hasBody ? `${shape}, ${res.bytes} bytes` : `HTTP ${res.status} with an empty body`,
    status: res.status,
    latencyMs: res.latencyMs,
    requests: [res.trace],
    capabilities: {},
  }
}
