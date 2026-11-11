// Delivery of the Projects tree to the sidebar.
//
// The Gateway answers sessions.catalog.list on a connection that already has a page from its cache
// without waiting for the provider (a zero budget), marks the host pending, and lets the provider's
// fresh host reach the sidebar through onHost (the sessions.catalog.host event). A provider that only
// returns its hosts never reaches the sidebar that way: the sidebar keeps its rows for a pending host,
// so new rows, run status and order changed since the previous refresh stayed off screen until a
// refresh happened to finish within the budget (10.11.2026).

/** Hands the finished host to the Gateway as a progressive provider does, then returns it. */
export function publishHost(params, host) {
  try {
    params?.onHost?.(host);
  } catch { /* the list was retired: the response or the next refresh carries the host */ }
  return host;
}
