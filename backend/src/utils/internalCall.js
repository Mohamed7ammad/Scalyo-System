/* Call an existing Express GET handler in-process — reuse its exact logic (and
   numbers) without an HTTP round trip or a copy of the code.
   routeHandler(router, '/wallet') → the handler after its auth middlewares;
   callHandler(handle, user, query) → { status, body }. */
'use strict';

function routeHandler(router, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods.get);
  if (!layer) throw new Error(`route GET ${path} not found`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function callHandler(handle, user, query = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = { method: 'GET', user, query, params: {}, body: {}, headers: {}, url: '', path: '', get: () => undefined };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      set() { return this; },
      setHeader() { return this; },
      getHeader() { return undefined; },
      json(body) { done({ status: this.statusCode, body }); return this; },
      send(body) { done({ status: this.statusCode, body }); return this; },
      end() { done({ status: this.statusCode, body: null }); return this; },
    };
    Promise.resolve()
      .then(() => handle(req, res, (err) => (err ? reject(err) : done({ status: 404, body: null }))))
      .catch(reject);
  });
}

module.exports = { routeHandler, callHandler };
