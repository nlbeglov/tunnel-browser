// Reading a Chromium net log (electron's netLog) for DNS that left this computer.
// Used by the self-test; no Electron imports, unit-tested.

export interface NetLog {
  constants: { logEventTypes: Record<string, number> };
  events: Array<{ type: number; phase?: number; params?: Record<string, unknown> }>;
}

/**
 * Names Chromium really tried to resolve here: a resolver job (system or built-in DNS) or a
 * DNS query on the wire. A request that is refused before any of that (host-resolver-rules)
 * does not count: nothing leaves the computer.
 */
export function dnsLookups(log: NetLog): string[] {
  const id = log.constants.logEventTypes;
  const job = id.HOST_RESOLVER_MANAGER_JOB;
  const query = id.DNS_TRANSACTION_QUERY;
  const out = new Set<string>();
  for (const e of log.events) {
    if (e.type === job && typeof e.params?.host === 'string') out.add(e.params.host.replace(/^[a-z]+:\/\//, ''));
    else if (e.type === query && typeof e.params?.qname === 'string') out.add(e.params.qname);
  }
  return [...out];
}
