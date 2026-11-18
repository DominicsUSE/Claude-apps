// The seam between Cloudflare's runtime and the Node test shim (registry/shim.js).
// In workerd the globals below exist; the shim passes its own implementation as env.__platform.

const cloudflare = {
  newPair() {
    const pair = new WebSocketPair(); // eslint-disable-line no-undef
    const [client, server] = Object.values(pair);
    return { client, server };
  },
  upgradeResponse(client, headers) {
    return new Response(null, { status: 101, webSocket: client, headers });
  },
  autoResponse(ctx, req, res) {
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(req, res)); // eslint-disable-line no-undef
  },
};

export function platform(env) {
  return env.__platform || cloudflare;
}

/** The registry clock. env.TEST_CLOCK is only ever set by the shim. */
export function now(env) {
  return typeof env.TEST_CLOCK === 'function' ? env.TEST_CLOCK() : Date.now();
}

export function isUpgrade(res) {
  return res && res.status === 101;
}
