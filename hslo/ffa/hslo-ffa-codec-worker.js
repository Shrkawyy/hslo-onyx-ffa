/**
 * HSLO Senpa codec worker (same isolated path as Onyx; FFA uses eu1.senpa.io:7101).
 * Only wasmLoader Module.create() — encrypt/decrypt Senpa FFA WebSocket.
 * Must not share embind state with HSLO PIXI on the page.
 */
/* eslint-disable no-undef */
(function () {
  "use strict";

  if (typeof self.window === "undefined") self.window = self;
  if (typeof self.document === "undefined") {
    self.document = {
      location: self.location,
      currentScript: null,
      baseURI: self.location.href
    };
  }

  var factories = Object.create(null);
  var installed = Object.create(null);

  function requireFactory(id) {
    if (installed[id]) return installed[id].exports;
    var factory = factories[id];
    if (!factory) throw new Error("FFA codec: webpack module " + id + " missing");
    var module = (installed[id] = { id: id, exports: {} });
    factory.call(module.exports, module, module.exports, requireFactory);
    return module.exports;
  }

  requireFactory.d = function (exports, definition) {
    for (var key in definition) {
      if (Object.prototype.hasOwnProperty.call(definition, key)) {
        Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
      }
    }
  };
  requireFactory.r = function () {};
  requireFactory.n = function (mod) {
    var getter = function () {
      return mod && mod.__esModule ? mod.default : mod;
    };
    requireFactory.d(getter, { a: getter });
    return getter;
  };
  requireFactory.o = function (obj, prop) {
    return Object.prototype.hasOwnProperty.call(obj, prop);
  };

  if (!self.webpackChunkeon_client) self.webpackChunkeon_client = [];
  function registerChunk(chunk) {
    if (!chunk || !chunk[1]) return;
    var mods = chunk[1];
    for (var id in mods) {
      if (Object.prototype.hasOwnProperty.call(mods, id)) factories[id] = mods[id];
    }
  }
  for (var i = 0; i < self.webpackChunkeon_client.length; i++) {
    registerChunk(self.webpackChunkeon_client[i]);
  }
  self.webpackChunkeon_client.push = function (chunk) {
    registerChunk(chunk);
    return self.webpackChunkeon_client.length;
  };

  if (!factories[458]) {
    try {
      importScripts("./wasmLoader.js");
    } catch (_) {}
  }

  var wasmFactory;
  try {
    wasmFactory = requireFactory(458).A;
  } catch (err) {
    self.postMessage({
      type: "error",
      code: "INITIALIZATION_FAILED",
      msg: "wasmLoader export A: " + (err && err.message || err)
    });
    return;
  }

  function isAllowedSenpaUrl(url) {
    var raw = String(url || "");
    return raw.indexOf("wss://eu1.senpa.io:7101") === 0 || raw.indexOf("wss://eu.senpa.io:2001") === 0;
  }

  var moduleInstance = null;
  var socket = null;
  var wasmBytes = null;
  var wasmUrl = null;
  var booting = false;
  var readyResolve;
  var readyReject;
  var ready = new Promise(function (resolve, reject) {
    readyResolve = resolve;
    readyReject = reject;
  });

  function boot() {
    if (booting) return ready;
    booting = true;
    return new Promise(function (resolve, reject) {
      var settled = false;
      var config = {
        locateFile: function (name) {
          if (wasmUrl) return wasmUrl;
          try {
            if (self.location && String(self.location.protocol) !== "blob:") {
              return new URL(name, self.location.href).href;
            }
          } catch (_) {}
          return name;
        },
        print: function (msg) {
          self.postMessage({ type: "log", msg: "[WASM] " + msg });
        },
        printErr: function (msg) {
          if (!settled) {
            settled = true;
            reject(new Error(String(msg)));
          }
        },
        onRuntimeInitialized: function () {
          if (!settled) {
            settled = true;
            resolve(moduleInstance);
          }
        }
      };
      if (wasmBytes) {
        config.instantiateWasm = function (info, receiveInstance) {
          WebAssembly.instantiate(wasmBytes, info)
            .then(function (result) {
              receiveInstance(result.instance, result.module);
            })
            .catch(function (err) {
              if (!settled) {
                settled = true;
                reject(err);
              }
            });
          return {};
        };
      }
      moduleInstance = wasmFactory(config);
    }).then(
      function (inst) {
        readyResolve(inst);
        self.postMessage({ type: "codec-ready" });
        return inst;
      },
      function (err) {
        readyReject(err);
        self.postMessage({
          type: "error",
          code: "INITIALIZATION_FAILED",
          msg: String(err && err.message || err)
        });
        throw err;
      }
    );
  }

  function connect(url) {
    if (!moduleInstance || typeof moduleInstance.create !== "function") {
      throw new Error("WASM create() missing");
    }
    if (!isAllowedSenpaUrl(url)) {
      throw new Error("[HSLO] Invalid codec URL: " + url);
    }
    socket = moduleInstance.create(
      url,
      function () {
        self.postMessage({ type: "open" });
      },
      function (code, reason, wasClean) {
        self.postMessage({
          type: "close",
          code: typeof code === "number" ? code : code && code.code,
          reason: String(reason || (code && code.reason) || ""),
          wasClean: !!(wasClean || (code && code.wasClean))
        });
      },
      function (data) {
        var buf;
        if (data && data.buffer && data.byteLength != null) {
          buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        } else if (data instanceof ArrayBuffer) {
          buf = data.slice(0);
        } else {
          return;
        }
        self.postMessage({ type: "message", data: buf }, [buf]);
      },
      function (err) {
        var msg = "ws error";
        if (err && err.message) msg = err.message;
        else if (err && err.type) msg = "WebSocket " + err.type;
        else if (err != null) msg = String(err);
        self.postMessage({ type: "error", code: "WS_ERROR", msg: msg });
      }
    );
  }

  function send(bytes) {
    if (!socket) return;
    if (bytes instanceof ArrayBuffer) socket.send(new Uint8Array(bytes));
    else socket.send(bytes);
  }

  function closeSock() {
    try {
      if (socket && socket.close) socket.close();
    } catch (_) {}
    socket = null;
  }

  if (self.location && String(self.location.protocol) !== "blob:") {
    boot();
  }

  self.onmessage = function (ev) {
    var msg = ev.data || {};
    if (msg.type === "init") {
      if (msg.data) {
        wasmBytes = msg.data instanceof Uint8Array ? msg.data : new Uint8Array(msg.data);
      }
      if (msg.wasmUrl) wasmUrl = msg.wasmUrl;
      boot();
      return;
    }
    if (msg.type === "connect") {
      ready
        .then(function () {
          connect(msg.url);
        })
        .catch(function (err) {
          self.postMessage({
            type: "error",
            code: "INITIALIZATION_FAILED",
            msg: String(err && err.message || err)
          });
        });
      return;
    }
    if (msg.type === "send") {
      send(msg.data);
      return;
    }
    if (msg.type === "alloc") {
      try {
        var fn = moduleInstance && (moduleInstance._alloc || moduleInstance.alloc);
        if (typeof fn === "function") fn.call(moduleInstance, msg.code, new Uint8Array(msg.data || 0));
      } catch (err) {
        self.postMessage({ type: "log", msg: "alloc failed: " + (err && err.message || err) });
      }
      return;
    }
    if (msg.type === "close") {
      closeSock();
    }
  };
})();
