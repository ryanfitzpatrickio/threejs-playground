/**
 * Bind a feature/controller instance so missing properties fall through to the
 * runtime kernel host. Call as `return bindRuntimeHost(this, host)` from the
 * feature constructor.
 *
 * Important: own methods must run with `this === proxy` so property access like
 * `this.physicsSystem` still falls through to the host. Host methods are bound
 * to the host so their original this-semantics are preserved.
 *
 * @param {object} feature feature instance (usually `this` in a constructor)
 * @param {object} host runtime kernel
 * @returns {object} proxied feature
 */
export function bindRuntimeHost(feature, host) {
  feature._host = host;

  const proxy = new Proxy(feature, {
    get(target, prop, receiver) {
      if (prop === '_host') return host;
      if (typeof prop === 'symbol') {
        return Reflect.get(target, prop, receiver);
      }

      // Own/instance + prototype members stay on the feature. Do not .bind(target):
      // method calls like proxy.foo() must keep this === proxy for host fallthrough.
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }

      const value = host[prop];
      if (typeof value === 'function') {
        return value.bind(host);
      }
      return value;
    },

    set(target, prop, value) {
      if (prop === '_host') {
        target._host = value;
        return true;
      }
      // Constructor-initialized own state stays on the feature.
      if (Object.prototype.hasOwnProperty.call(target, prop)) {
        target[prop] = value;
        return true;
      }
      // Shared runtime fields (and first-time writes of kernel-owned keys) go to host.
      host[prop] = value;
      return true;
    },

    has(target, prop) {
      return prop in target || prop in host;
    },
  });

  return proxy;
}
