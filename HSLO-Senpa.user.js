// ==UserScript==
// @name         HSLO Senpa FFA (Vercel)
// @homepageURL  https://github.com/Shrkawyy/hslo-onyx-ffa
// @supportURL   https://github.com/Shrkawyy/hslo-onyx-ffa/issues
// @updateURL    https://raw.githubusercontent.com/Shrkawyy/hslo-onyx-ffa/main/HSLO-Senpa.user.js
// @downloadURL  https://raw.githubusercontent.com/Shrkawyy/hslo-onyx-ffa/main/HSLO-Senpa.user.js
// @namespace    https://hslo.local/senpa
// @version      1.4.1
// @description  Loads the deployed HSLO 5.4.0 client on senpa.io with ONYX-compatible FFA and EU Dual support.
// @author       Shrkawy
// @match        https://senpa.io/*
// @match        https://www.senpa.io/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_info
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// @connect      *
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  var DEFAULT_BASE_URL = "https://hslo-onyx-ffa.vercel.app/";
  var VERSION = "1.4.1";
  var FALLBACK_BASES = [
    DEFAULT_BASE_URL,
    "http://127.0.0.1:8765/",
    "http://localhost:8765/",
    "http://127.0.0.1:5500/",
    "http://localhost:5500/",
    "http://127.0.0.1:8765/hslo/",
    "http://127.0.0.1:5500/hslo/",
  ];

  function isLocalHost(hostname) {
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
      /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
    );
  }

  function normalizeBaseUrl(value) {
    try {
      var url = new URL(value);
      if (url.protocol !== "https:" && !isLocalHost(url.hostname)) return DEFAULT_BASE_URL;
      return url.href.endsWith("/") ? url.href : url.href + "/";
    } catch (_) {
      return DEFAULT_BASE_URL;
    }
  }

  function getBaseUrl() {
    var override = "";
    try {
      override = localStorage.getItem("hslo:base-url") || "";
    } catch (_) {}
    // Ignore stale localhost values written by pre-1.3 releases; the deployed client is now primary.
    if (/^http:\/\/(127\.0\.0\.1|localhost)(?::\d+)?\//i.test(override)) override = "";
    return normalizeBaseUrl(override || DEFAULT_BASE_URL);
  }

  function candidateBases() {
    var first = getBaseUrl();
    var list = [first];
    for (var i = 0; i < FALLBACK_BASES.length; i++) {
      if (list.indexOf(FALLBACK_BASES[i]) < 0) list.push(FALLBACK_BASES[i]);
    }
    return list;
  }

  function srcOf(el) {
    return (
      (el &&
        (el.src ||
          el.href ||
          (el.getAttribute && (el.getAttribute("src") || el.getAttribute("href"))))) ||
      ""
    );
  }

  function isAllowedKeep(src) {
    if (!src) return false;
    if (src.indexOf("blob:") === 0) return true;
    if (/hslo/i.test(src)) return true;
    if (/127\.0\.0\.1|localhost/i.test(src)) return true;
    if (/fonts\.googleapis\.com|fonts\.gstatic\.com|use\.fontawesome\.com/i.test(src)) return true;
    if (/challenges\.cloudflare\.com/i.test(src)) return true;
    if (/google\.com\/recaptcha|gstatic\.com\/recaptcha/i.test(src)) return true;
    if (/connect\.facebook\.net|apis\.google\.com/i.test(src)) return true;
    return false;
  }

  function isOfficialAsset(url) {
    var s = String(url || "");
    if (!s || isAllowedKeep(s)) return false;
    if (/tracker\.senpa\.io/i.test(s)) return false;
    if (/api\.senpa\.io\/(auth|skins|u\/)/i.test(s)) return false;
    if (/i\.imgur\.com/i.test(s)) return false;
    if (/agar\.io\/mc\/agario\.js/i.test(s)) return true;
    if (/wss?:\/\/[^/]*senpa\.io/i.test(s)) return false;
    if (/senpa\.io\/web\/assets\//i.test(s)) return true;
    if (/main-[A-Za-z0-9_-]+\.(js|css)/i.test(s) && /senpa\.io/i.test(s)) return true;
    if (/senpa\.io\/web\/bundle\.wasm/i.test(s)) return true;
    if (/tag\.min\.js|adinplay|prebid|gameads|ad-manager/i.test(s)) return true;
    if (/api\.senpa\.io\/settings/i.test(s)) return true;
    return false;
  }

  function hrefOf(input) {
    if (!input) return "";
    if (typeof input === "string") return input;
    if (typeof URL !== "undefined" && input instanceof URL) return String(input);
    if (typeof Request !== "undefined" && input instanceof Request) return input.url || "";
    return (input && input.url) || String(input);
  }

  function blockOfficialNetwork() {
    try {
      var nativeFetch = window.fetch;
      if (nativeFetch) {
        window.fetch = function (input, init) {
          var url = hrefOf(input);
          if (isOfficialAsset(url)) {
            return Promise.resolve(new Response("", { status: 204, statusText: "HSLO blocked" }));
          }
          return nativeFetch.apply(this, arguments);
        };
      }
    } catch (_) {}
    try {
      var open = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url) {
        if (typeof url === "string" && isOfficialAsset(url)) {
          arguments[1] = "data:text/plain,";
        }
        return open.apply(this, arguments);
      };
    } catch (_) {}
    try {
      var setAttr = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function (name, value) {
        if (
          this.tagName === "SCRIPT" &&
          String(name).toLowerCase() === "src" &&
          !isAllowedKeep(String(value || ""))
        ) {
          try {
            this.type = "javascript/blocked";
          } catch (_) {}
          return;
        }
        return setAttr.call(this, name, value);
      };
    } catch (_) {}
  }

  function blockAutoReload() {
    function noReload() {
      console.log("[HSLO] blocked page reload");
    }
    try {
      Location.prototype.reload = noReload;
    } catch (_) {}
    try {
      window.location.reload = noReload;
    } catch (_) {}
  }

  function killSenpaRuntime() {
    try {
      if (navigator.serviceWorker) {
        navigator.serviceWorker.getRegistrations().then(function (regs) {
          for (var i = 0; i < regs.length; i++) regs[i].unregister();
        }).catch(function () {});
        try {
          Object.defineProperty(navigator, "serviceWorker", {
            configurable: true,
            get: function () {
              return undefined;
            }
          });
        } catch (_) {
          if (navigator.serviceWorker.register) {
            navigator.serviceWorker.register = function () {
              return Promise.reject(new Error("HSLO blocked service worker"));
            };
          }
        }
      }
    } catch (_) {}
    try {
      if (window.caches && caches.keys) {
        caches.keys().then(function (keys) {
          for (var i = 0; i < keys.length; i++) caches.delete(keys[i]);
        }).catch(function () {});
      }
    } catch (_) {}
    try {
      var proto = HTMLScriptElement.prototype;
      var desc =
        Object.getOwnPropertyDescriptor(proto, "src") ||
        Object.getOwnPropertyDescriptor(HTMLElement.prototype, "src");
      if (desc && desc.set) {
        Object.defineProperty(proto, "src", {
          configurable: true,
          enumerable: desc.enumerable,
          get: desc.get,
          set: function (value) {
            if (!isAllowedKeep(String(value || ""))) {
              try {
                this.type = "javascript/blocked";
              } catch (_) {}
              return;
            }
            return desc.set.call(this, value);
          },
        });
      }
    } catch (_) {}
  }

  function isOfficialRuntimeNode(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName;
    var src = srcOf(el);
    if (isAllowedKeep(src)) return false;
    if (tag === "SCRIPT" || tag === "IFRAME" || tag === "EMBED" || tag === "OBJECT") return true;
    if (tag === "LINK") {
      var rel = (el.rel || "").toLowerCase();
      if (rel === "modulepreload" || rel === "preload" || rel === "module") return true;
      if (/main-|adinplay|prebid|ad-manager|tag\.min/i.test(src)) return true;
    }
    return false;
  }

  function stripOfficial(root) {
    if (!root || root.nodeType !== 1) return;
    if (isOfficialRuntimeNode(root)) {
      root.remove();
      return;
    }
    var nodes = root.querySelectorAll(
      "script,iframe,embed,object,link[rel='modulepreload'],link[rel='preload'],link[rel='module']"
    );
    for (var i = 0; i < nodes.length; i++) {
      if (isOfficialRuntimeNode(nodes[i])) nodes[i].remove();
    }
  }

  function seizePage() {
    try {
      window.stop();
    } catch (_) {}
    try {
      document.open();
      document.write(
        "<!doctype html><html><head><meta charset='utf-8'><title>HSLO</title></head><body></body></html>"
      );
      document.close();
    } catch (_) {}
    var observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var added = records[i].addedNodes;
        for (var j = 0; j < added.length; j++) stripOfficial(added[j]);
      }
    });
    if (document.documentElement) {
      observer.observe(document.documentElement, { childList: true, subtree: true });
      stripOfficial(document.documentElement);
    }
    return observer;
  }

  function renderLoading() {
    var style = document.createElement("style");
    style.textContent =
      "html{background:#111!important}body{visibility:hidden!important}" +
      "html::before{content:'Loading HSLO...';position:fixed;z-index:2147483647;inset:0;display:grid;place-items:center;background:#111;color:#f05c5b;font:700 18px Rajdhani,system-ui,sans-serif;letter-spacing:.16em;visibility:visible}";
    (document.head || document.documentElement).appendChild(style);
  }

  function renderError(message) {
    document.title = "HSLO load error";
    document.documentElement.innerHTML =
      "<head></head><body style='margin:0;background:#111;color:#fff;font:16px system-ui;display:grid;place-items:center;height:100vh'>" +
      "<div style='max-width:640px;padding:28px;border:1px solid #333;border-radius:12px'>" +
      "<h1 style='color:#f05c5b'>HSLO could not load</h1>" +
      "<p>" +
      String(message).replace(/[<>]/g, "") +
      "</p>" +
      "<p>1. Dy-klik <b>start-hslo.cmd</b>.<br>" +
      "2. Dritarja CMD duhet te MBETET HAPUR.<br>" +
      "3. Rifresko kete faqe (Ctrl+F5).</p>" +
      "<p>Nese CMD thote 8765, ekzekuto ne Console (F12):<br>" +
      "<code>localStorage.setItem('hslo:base-url','http://127.0.0.1:8765/')</code></p>" +
      "</div></body>";
  }

  function bufToB64(buf) {
    var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var chunk = 0x8000;
    var s = "";
    for (var i = 0; i < u8.length; i += chunk) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    return btoa(s);
  }

  function gmGet(url, responseType) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: "GET",
        url: url,
        responseType: responseType || "text",
        binary: responseType === "arraybuffer",
        timeout: 30000,
        headers: { "Cache-Control": "no-cache" },
        onload: function (response) {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(url + " HTTP " + response.status));
            return;
          }
          resolve(response.response);
        },
        onerror: function () {
          reject(new Error("Request failed: " + url));
        },
        ontimeout: function () {
          reject(new Error("Request timed out: " + url));
        },
      });
    });
  }

  function rewriteAssets(doc, baseUrl) {
    var nodes = doc.querySelectorAll("[href],[src]");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var attr = el.hasAttribute("src") ? "src" : "href";
      var value = el.getAttribute(attr);
      if (!value) continue;
      if (el.tagName === "LINK" && /stylesheet/i.test(el.rel || "")) continue;
      if (/^(https?:|data:|blob:|#|\/\/)/i.test(value)) continue;
      el.setAttribute(attr, new URL(value, baseUrl).href);
    }
  }

  function rewriteLocalUrls(text, baseUrl) {
    var origin = String(baseUrl || "").replace(/\/$/, "");
    return String(text || "")
      .replace(
        /(url\(\s*['"]?)(\/(?:img|cursors|fonts|sounds|data|emojis|skins|config|assets|vendor)\/)/gi,
        function (_, pre, path) {
          return pre + origin + path;
        }
      )
      .replace(
        /(["'`])(\/(?:img|cursors|fonts|sounds|data|emojis|skins|config|assets|vendor)\/)/g,
        function (_, q, path) {
          return q + origin + path;
        }
      );
  }

  function injectScript(text, label) {
    return new Promise(function (resolve, reject) {
      var blob = new Blob([text + "\n//# sourceURL=hslo://" + label], { type: "text/javascript" });
      var script = document.createElement("script");
      script.src = URL.createObjectURL(blob);
      script.addEventListener("load", function () { resolve(); }, { once: true });
      script.addEventListener("error", function () { reject(new Error("inject failed: " + label)); }, { once: true });
      document.body.appendChild(script);
    });
  }

  function injectModule(text, label) {
    return new Promise(function (resolve, reject) {
      var blob = new Blob([text + "\n//# sourceURL=hslo://" + label], { type: "text/javascript" });
      var script = document.createElement("script");
      script.type = "module";
      script.src = URL.createObjectURL(blob);
      var done = false;
      function ok() {
        if (done) return;
        done = true;
        resolve();
      }
      script.addEventListener("load", ok, { once: true });
      script.addEventListener(
        "error",
        function () {
          if (done) return;
          done = true;
          reject(new Error("inject failed: " + label));
        },
        { once: true }
      );
      document.body.appendChild(script);
      var n = 0;
      var timer = setInterval(function () {
        n++;
        if (done) {
          clearInterval(timer);
          return;
        }
        if (window.q && typeof window.q.init === "function") {
          clearInterval(timer);
          ok();
          return;
        }
        if (n > 80) {
          clearInterval(timer);
          if (!done) reject(new Error("module timeout: " + label));
        }
      }, 100);
    });
  }

  async function mount(baseUrl) {
    if (window.__HSLO_MOUNTED__) return;
    var v = encodeURIComponent(VERSION);
    var html = await gmGet(baseUrl + "index.html?v=" + v);
    var css = await gmGet(baseUrl + "assets/index-D4PvWIe0.css?v=" + v);
    var pixiJs = await gmGet(baseUrl + "vendor/pixi.min.js?v=" + v);
    var protoJs = await gmGet(baseUrl + "vendor/protobuf.min.js?v=" + v);
    var jqueryJs = await gmGet(baseUrl + "assets/BSHpiO4B.js?v=" + v);
    var mainJs = await gmGet(baseUrl + "assets/CGdlk7rS.js?v=" + v);
    var serversJs = await gmGet(baseUrl + "hslo-senpa-servers.js?v=" + v);
    var clientJs = await gmGet(baseUrl + "hslo-senpa-client.js?v=" + v);
    var authJs = await gmGet(baseUrl + "hslo-senpa-auth.js?v=" + v);
    var wasmLoader = await gmGet(baseUrl + "ffa/wasmLoader.js?v=" + v);
    var codecJs = await gmGet(baseUrl + "ffa/hslo-ffa-codec.js?v=" + v);
    var workerJs = await gmGet(baseUrl + "ffa/hslo-ffa-codec-worker.js?v=" + v);
    var wasmBuf = null;
    try {
      wasmBuf = await gmGet(baseUrl + "ffa/bundle.wasm?v=" + v, "arraybuffer");
    } catch (_) {
      wasmBuf = null;
    }
    if (!wasmBuf || !wasmBuf.byteLength) wasmBuf = null;

    if (String(html).indexOf("id=\"canvas\"") < 0) {
      throw new Error("index.html is not HSLO (wrong folder / server). Keep start-hslo.cmd open.");
    }

    var jqueryBlob = URL.createObjectURL(
      new Blob([jqueryJs + "\n//# sourceURL=hslo://BSHpiO4B.js"], { type: "text/javascript" })
    );
    mainJs = mainJs.replace(/from\s*["']\.\/BSHpiO4B\.js["']/, "from " + JSON.stringify(jqueryBlob));
    css = rewriteLocalUrls(css, baseUrl);
    mainJs = rewriteLocalUrls(mainJs, baseUrl);

    var parsed = new DOMParser().parseFromString(html, "text/html");
    if (!parsed.head || !parsed.body) throw new Error("index.html is not a complete HTML document.");
    parsed.querySelectorAll("script").forEach(function (node) { node.remove(); });
    parsed.querySelectorAll("link[rel='modulepreload']").forEach(function (node) { node.remove(); });
    parsed.querySelectorAll("link[rel='stylesheet']").forEach(function (node) {
      var href = node.getAttribute("href") || "";
      if (/fontawesome|fonts\.googleapis|fonts\.gstatic/i.test(href)) return;
      node.remove();
    });
    rewriteAssets(parsed, baseUrl);

    var style = parsed.createElement("style");
    style.setAttribute("data-hslo-css", "bundled");
    style.textContent = css;
    parsed.head.appendChild(style);

    window.stop();
    document.documentElement.replaceChildren(
      document.importNode(parsed.head, true),
      document.importNode(parsed.body, true)
    );
    document.title = "HSLO";

    await injectScript(
      "window.__HSLO_USERSCRIPT__=true;" +
        "window.__HSLO_BASE__=" +
        JSON.stringify(baseUrl) +
        ";" +
        "(function(){" +
        "if(!window.FB){window.FB={init:function(){},login:function(){},logout:function(){},getLoginStatus:function(){},Event:{subscribe:function(){},unsubscribe:function(){}}};}" +
        "if(!window.gapi){window.gapi={load:function(){}};}" +
        "if(!window.grecaptcha){window.grecaptcha={ready:function(cb){try{cb&&cb()}catch(e){}},execute:function(){return Promise.resolve('')},reset:function(){},render:function(){return 0},v2mode:false,onceLoad:true};}" +
        "try{var p=HTMLImageElement.prototype;var d=Object.getOwnPropertyDescriptor(p,'src');" +
        "if(d&&d.set){Object.defineProperty(p,'src',{configurable:true,enumerable:d.enumerable,get:d.get,set:function(v){" +
        "if(/^https?:\\/\\/(127\\.0\\.0\\.1|localhost)/i.test(String(v||''))){try{this.crossOrigin='anonymous';}catch(e){}}" +
        "return d.set.call(this,v);}});}}catch(e){}" +
        "if(window.__HSLO_NATIVE_WS__){window.WebSocket=window.__HSLO_NATIVE_WS__;}" +
        "try{if(window.app) window.app=null;}catch(e){}" +
        "console.log('[HSLO] BOOT origin='+location.origin+' base='+window.__HSLO_BASE__);" +
        "})();",
      "boot.js"
    );
    await injectScript(pixiJs, "pixi.min.js");
    await injectScript(protoJs, "protobuf.min.js");
    await injectScript(
      "window.__HSLO_WORKER_SRC__=" +
        JSON.stringify(String(wasmLoader) + "\n" + String(workerJs)) +
        ";window.__HSLO_WASM_B64__=" +
        JSON.stringify(wasmBuf && wasmBuf.byteLength ? bufToB64(wasmBuf) : "") +
        ";window.__KATERONYX_WASM_B64__=window.__HSLO_WASM_B64__;" +
        "window.__KATERONYX_BASE_URL=" +
        JSON.stringify(baseUrl) +
        ";console.log('[HSLO] senpa wasm bytes='+(window.__HSLO_WASM_B64__||'').length);",
      "ffa-wasm.js"
    );
    await injectScript(wasmLoader, "wasmLoader.js");
    await injectScript(codecJs, "hslo-ffa-codec.js");
    await injectScript(authJs, "hslo-senpa-auth.js");
    await injectScript(serversJs, "hslo-senpa-servers.js");
    await injectScript(clientJs, "hslo-senpa-client.js");
    await injectModule(mainJs, "CGdlk7rS.js");
    window.__HSLO_MOUNTED__ = true;
    try {
      localStorage.setItem("hslo:base-url", baseUrl);
    } catch (_) {}
    console.log("[HSLO] client mounted from", baseUrl);
  }

  async function mountFirstAvailable() {
    var bases = candidateBases();
    var lastErr = null;
    for (var i = 0; i < bases.length; i++) {
      try {
        console.log("[HSLO] trying", bases[i]);
        await mount(bases[i]);
        return;
      } catch (err) {
        lastErr = err;
        console.warn("[HSLO] miss", bases[i], err && err.message);
      }
    }
    throw lastErr || new Error("No local server found");
  }

  try {
    if (window.opener && window.opener !== window) {
      console.log("[HSLO] popup window — senpa login left untouched");
      return;
    }
  } catch (_) {}

  blockOfficialNetwork();
  blockAutoReload();
  try {
    if (!window.__HSLO_NATIVE_WS__ && window.WebSocket) {
      var NativeWSEarly = window.WebSocket;
      window.__HSLO_NATIVE_WS__ = NativeWSEarly;
      function BlockOfficialFfa(url, protocols) {
        if (/eu\.senpa\.io:\d+|eu1\.senpa\.io:\d+/.test(String(url || "")) && !window.__HSLO_ALLOW_SENPA_WS__ && !window.__HSLO_ALLOW_FFA_WS__) {
          console.log("[HSLO] blocked official senpa socket before mount");
          return {
            url: String(url),
            readyState: 3,
            bufferedAmount: 0,
            binaryType: "arraybuffer",
            protocol: "",
            extensions: "",
            send: function () {},
            close: function () {},
            addEventListener: function () {},
            removeEventListener: function () {},
            dispatchEvent: function () { return true; }
          };
        }
        return protocols !== undefined ? new NativeWSEarly(url, protocols) : new NativeWSEarly(url);
      }
      BlockOfficialFfa.prototype = NativeWSEarly.prototype;
      BlockOfficialFfa.CONNECTING = NativeWSEarly.CONNECTING;
      BlockOfficialFfa.OPEN = NativeWSEarly.OPEN;
      BlockOfficialFfa.CLOSING = NativeWSEarly.CLOSING;
      BlockOfficialFfa.CLOSED = NativeWSEarly.CLOSED;
      window.WebSocket = BlockOfficialFfa;
    }
  } catch (_) {}
  try {
    if (typeof unsafeWindow !== "undefined" && unsafeWindow !== window) {
      var uw = unsafeWindow;
      var pageFetch = uw.fetch;
      if (pageFetch) {
        uw.fetch = function (input, init) {
          var url = hrefOf(input);
          if (isOfficialAsset(url)) {
            return Promise.resolve(new Response("", { status: 204, statusText: "HSLO blocked" }));
          }
          return pageFetch.apply(this, arguments);
        };
      }
      try {
        uw.location.reload = function () {
          console.log("[HSLO] blocked page reload");
        };
      } catch (_) {}
      try {
        if (!uw.__HSLO_NATIVE_WS__ && uw.WebSocket) {
          uw.__HSLO_NATIVE_WS__ = uw.WebSocket;
        }
      } catch (_) {}
    }
  } catch (_) {}
  try {
    var pageHook = document.createElement("script");
    pageHook.textContent =
      "(function(){if(window.__HSLO_PAGE_HOOK__)return;window.__HSLO_PAGE_HOOK__=true;" +
      "var Native=window.WebSocket;if(Native&&!window.__HSLO_NATIVE_WS__){window.__HSLO_NATIVE_WS__=Native;" +
      "function Block(url,p){if(/eu\\.senpa\\.io:\\d+|eu1\\.senpa\\.io:\\d+/.test(String(url||''))&&!window.__HSLO_ALLOW_SENPA_WS__&&!window.__HSLO_ALLOW_FFA_WS__){" +
      "console.log('[HSLO] blocked official senpa socket');" +
      "return {url:String(url),readyState:3,binaryType:'arraybuffer',send:function(){},close:function(){},addEventListener:function(){},removeEventListener:function(){}};" +
      "}return p!==undefined?new Native(url,p):new Native(url);}" +
      "Block.prototype=Native.prototype;Block.CONNECTING=Native.CONNECTING;Block.OPEN=Native.OPEN;Block.CLOSING=Native.CLOSING;Block.CLOSED=Native.CLOSED;" +
      "window.WebSocket=Block;}" +
      "var nf=window.fetch;if(nf){window.fetch=function(i,n){var u='';try{u=typeof i==='string'?i:(i&&i.url)||'';}catch(e){}" +
      "if(/senpa\\.io\\/web\\/(assets\\/|bundle\\.wasm)|main-[A-Za-z0-9_-]+\\.(js|css)|tag\\.min\\.js|adinplay|api\\.senpa\\.io\\/settings/i.test(u)" +
      "&&!/tracker\\.senpa\\.io|api\\.senpa\\.io\\/auth|127\\.0\\.0\\.1|localhost|blob:/i.test(u))" +
      "{return Promise.resolve(new Response('',{status:204}));}return nf.apply(this,arguments);};}" +
      "try{Location.prototype.reload=function(){console.log('[HSLO] blocked page reload');};}catch(e){}" +
      "try{window.location.reload=function(){console.log('[HSLO] blocked page reload');};}catch(e){}" +
      "})();";
    (document.documentElement || document.head || document).appendChild(pageHook);
    pageHook.remove();
  } catch (_) {}
  killSenpaRuntime();
  seizePage();
  renderLoading();
  mountFirstAvailable().catch(function (error) {
    renderError(error && error.message ? error.message : error);
  });
})();
