/**
 * HSLO Senpa client — EU Dual + FFA Europe from zero.
 *
 * UI → Server Manager → selected adapter → WASM connection → protocol.
 * Connection/handshake follow ONYX EU Dual (Module.create, wss://host?password=).
 * FFA Europe uses the same connection path with FFA packet shapes from Dual source.
 */
(function (global) {
  "use strict";

  var catalog = global.HSLOSenpaServers;
  if (!catalog) {
    console.error("[HSLO] server catalog missing");
    return;
  }

  var NativeWS = global.__HSLO_NATIVE_WS__ || global.WebSocket;
  var HANDSHAKE_MS = 8000;
  var RECONNECT_BASE_MS = 400;
  var RECONNECT_MAX_MS = 8000;
  var RECONNECT_TRIES = 6;
  var AGAR_EDGE = 14142;
  var FFA_HOST = "eu1.senpa.io:7101";
  var FFA_TID_KEY = "hslo:senpa-tid";
  var PEER_MARK = "H54MAP";
  var PEER_ZW = "\u200b";

  var st = {
    gen: 0,
    server: null,
    socketOpen: false,
    connecting: false,
    authOk: false,
    authSent: false,
    clientId: 0,
    playerIds: [],
    border: 0,
    mouseX: 0,
    mouseY: 0,
    lastCx: 0,
    lastCy: 0,
    viewSenX: 0,
    viewSenY: 0,
    specAgarX: 0,
    specAgarY: 0,
    specTargetX: 0,
    specTargetY: 0,
    specHasTarget: false,
    macroTimer: null,
    splitTimers: [],
    splitOp: 0,
    massProto: null,
    hotkeysLive: Object.create(null),
    play: false,
    spectate: false,
    spawned: false,
    spawnedTab1: false,
    spawnedTab2: false,
    wantSpawn1: false,
    wantSpawn2: false,
    controllingTab: 1,
    rxLog: 0,
    txLog: 0,
    pingTimer: null,
    cursorTimer: null,
    spawnTimer: null,
    handshakeTimer: null,
    reconnectTimer: null,
    reconnectMs: RECONNECT_BASE_MS,
    reconnectLeft: RECONNECT_TRIES,
    allowNative: false,
    pageCodec: false,
    worker: null,
    players: Object.create(null),
    clients: Object.create(null),
    identityLogged: false,
    lastStatus: "",
    peers: Object.create(null),
    peerMapRaf: 0
  };

  function debugOn() {
    if (global.DEBUG_NETWORK === true) return true;
    try {
      return localStorage.getItem("hslo:debug-network") === "true";
    } catch (_) {
      return false;
    }
  }

  function log(tag, msg) {
    var line = "[HSLO] [" + tag + "] " + msg;
    if (tag === "ERROR" || debugOn() || tag === "SERVER" || tag === "CONNECT" || tag === "HANDSHAKE" || tag === "AUTH" || tag === "GAME" || tag === "MULTIBOX") {
      console.log(line);
    }
  }

  function status(text, isError) {
    st.lastStatus = text;
    try {
      var el = document.getElementById("hslo-senpa-status");
      if (el && el.parentNode) el.parentNode.removeChild(el);
    } catch (_) {}
    log(isError ? "ERROR" : "GAME", text);
  }

  function regionsEl() {
    return document.getElementById("regions");
  }

  function lockRegionsPrototype() {
    if (HTMLSelectElement.prototype.__hsloSelIdx) return;
    var desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "selectedIndex");
    if (!desc || typeof desc.get !== "function" || typeof desc.set !== "function") return;
    HTMLSelectElement.prototype.__hsloSelIdx = true;
    Object.defineProperty(HTMLSelectElement.prototype, "selectedIndex", {
      configurable: true,
      enumerable: desc.enumerable,
      get: function () {
        var v = desc.get.call(this);
        if (this.id === "regions" && !(v >= 0) && this.options && this.options.length) {
          desc.set.call(this, 0);
          return 0;
        }
        return v;
      },
      set: function (v) {
        if (this.id === "regions" && !(v >= 0) && this.options && this.options.length) v = 0;
        return desc.set.call(this, v);
      }
    });
  }

  function ensureSenpaRegion() {
    var sel = regionsEl();
    if (!sel || !sel.options.length) return;
    var cur = sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
    if (cur && catalog.fromOption(cur)) return;
    var saved = restoreSelectionId();
    var pick = 0;
    for (var i = 0; i < sel.options.length; i++) {
      var srv = catalog.fromOption(sel.options[i]);
      if (!srv) continue;
      pick = i;
      if (saved && srv.id === saved) break;
    }
    sel.selectedIndex = pick;
  }

  function syncRegionStore() {
    var store = global.c;
    var sel = regionsEl();
    if (!store || typeof store.set !== "function" || !sel || sel.selectedIndex < 0) return;
    var val = sel.value;
    if (!val) return;
    try {
      if (typeof store.get === "function" && store.get("extras", "region") === val) return;
      store.set("extras", "region", val);
    } catch (_) {}
  }

  function watchDocumentForRegions() {
    if (document.__hsloRegionWatch) return;
    document.__hsloRegionWatch = true;
    var obs = new MutationObserver(function () {
      if (!regionsEl()) return;
      injectOptions();
      ensureSenpaRegion();
      obs.disconnect();
      watchRegions();
    });
    var root = document.documentElement || document;
    obs.observe(root, { childList: true, subtree: true });
    if (regionsEl()) {
      injectOptions();
      ensureSenpaRegion();
      obs.disconnect();
    }
  }

  lockRegionsPrototype();
  watchDocumentForRegions();

  function selectedServer() {
    var el = regionsEl();
    if (!el || el.selectedIndex < 0) return null;
    return catalog.fromOption(el.options[el.selectedIndex]);
  }

  function isSenpaSelected() {
    return !!selectedServer();
  }

  function persistSelection(server) {
    try {
      if (server) localStorage.setItem(catalog.storageKey, server.id);
    } catch (_) {}
  }

  function restoreSelectionId() {
    try {
      return localStorage.getItem(catalog.storageKey) || "";
    } catch (_) {
      return "";
    }
  }

  function ffaTid() {
    var existing = "";
    try {
      existing = sessionStorage.getItem(FFA_TID_KEY) || "";
    } catch (_) {}
    if (/^[a-f0-9]{32}$/i.test(existing)) return existing.toLowerCase();
    var value = "";
    try {
      if (global.crypto && typeof global.crypto.randomUUID === "function") {
        value = global.crypto.randomUUID().replace(/-/g, "");
      } else if (global.crypto && typeof global.crypto.getRandomValues === "function") {
        var bytes = global.crypto.getRandomValues(new Uint8Array(16));
        for (var i = 0; i < bytes.length; i++) value += ("0" + bytes[i].toString(16)).slice(-2);
      }
    } catch (_) {}
    if (!/^[a-f0-9]{32}$/i.test(value)) {
      value = "00000000000000000000000000000000";
    }
    try {
      sessionStorage.setItem(FFA_TID_KEY, value);
    } catch (_) {}
    return value;
  }

  function isFfaServer(server) {
    return !!(server && (server.mode === "ffa" || String(server.host || "") === FFA_HOST));
  }

  function wsUrl(server) {
    if (isFfaServer(server)) {
      return "wss://" + FFA_HOST + "?po=" + encodeURIComponent(global.location && global.location.host || "") + "&tid=" + ffaTid();
    }
    return "wss://" + server.host + "?password=";
  }

  function readJwt() {
    var auth = global.HSLOAuth;
    if (auth && typeof auth.getToken === "function") {
      var t = auth.getToken();
      if (t) return t;
    }
    try {
      var a = localStorage.getItem("senpaio:session") || "";
      if (a && a.split(".").length >= 3) return a;
      var b = localStorage.getItem("senpa_auth_token") || "";
      if (b && b.split(".").length >= 3) return b;
    } catch (_) {}
    return "null";
  }

  function Writer(size) {
    this.offset = 0;
    this.view = new DataView(new ArrayBuffer(size || 8192));
  }
  Writer.prototype.u8 = function (v) {
    this.view.setUint8(this.offset++, v);
  };
  Writer.prototype.u16 = function (v) {
    this.view.setUint16(this.offset, v, true);
    this.offset += 2;
  };
  Writer.prototype.i32 = function (v) {
    this.view.setInt32(this.offset, v, true);
    this.offset += 4;
  };
  Writer.prototype.str16 = function (t) {
    t = String(t || "");
    if (t.length > 255) t = t.substring(0, 255);
    this.u8(t.length);
    for (var i = 0; i < t.length; i++) this.u16(t.charCodeAt(i));
  };
  Writer.prototype.str16u16 = function (t) {
    t = String(t || "");
    if (t.length > 65535) t = t.substring(0, 65535);
    this.u16(t.length);
    for (var i = 0; i < t.length; i++) this.u16(t.charCodeAt(i));
  };
  Writer.prototype.out = function () {
    return this.view.buffer.slice(0, this.offset);
  };

  function Reader(view) {
    this.view = view;
    this.offset = 0;
  }
  Reader.prototype.left = function () {
    return this.view.byteLength - this.offset;
  };
  Reader.prototype.need = function (n) {
    if (this.offset + n > this.view.byteLength) {
      throw new RangeError("senpa packet truncated");
    }
  };
  Reader.prototype.u8 = function () {
    this.need(1);
    return this.view.getUint8(this.offset++);
  };
  Reader.prototype.i8 = function () {
    this.need(1);
    return this.view.getInt8(this.offset++);
  };
  Reader.prototype.u16 = function () {
    this.need(2);
    var v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  };
  Reader.prototype.u24 = function () {
    return (this.u8() << 16) | (this.u8() << 8) | this.u8();
  };
  Reader.prototype.u32 = function () {
    this.need(4);
    var v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  };
  Reader.prototype.i32 = function () {
    this.need(4);
    var v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  };
  Reader.prototype.str16 = function () {
    var len = this.u8();
    var n = "";
    for (var i = 0; i < len; i++) n += String.fromCharCode(this.u16());
    return n.replace(/(\r|\n|\u00ff ?|\u0bcc|\u0bf5|\ue9c5)/g, "");
  };
  Reader.prototype.str8 = function () {
    var len = this.u8();
    var n = "";
    for (var i = 0; i < len; i++) n += String.fromCharCode(this.u8());
    return n;
  };

  function toU8(buf) {
    if (!buf) return null;
    if (buf instanceof Uint8Array) return buf;
    if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
    if (buf.buffer instanceof ArrayBuffer) {
      return new Uint8Array(buf.buffer, buf.byteOffset || 0, buf.byteLength || buf.buffer.byteLength);
    }
    return null;
  }

  function pageCodec() {
    return global.HSLOFfaCodec || global.HSLOSenpaCodec || global.ONYXFfaCodec || null;
  }

  function packetLog(dir, opcode, length) {
    st.txLog += dir === "OUT" ? 1 : 0;
    if (st.rxLog < 32 || debugOn()) {
      if (dir === "IN") st.rxLog++;
      log("PACKET", dir + " opcode=" + opcode + " length=" + length + " t=" + Date.now());
    }
  }

  function dualMode() {
    return !!(st.server && st.server.mode === "dual");
  }

  function tabByteFor(tab) {
    if (!dualMode()) return 0;
    return tab === 2 ? 1 : 0;
  }

  function tabByte() {
    return tabByteFor(st.controllingTab);
  }

  function mbLog(botId, opType, opId) {
    console.log("[MULTIBOX]", "botId:", botId, "activeBot:", st.controllingTab, "operation:", opId, "type:", opType);
  }

  function sendBuf(buf) {
    if (!st.socketOpen) return;
    var u8 = toU8(buf);
    if (u8 && u8.length) packetLog("OUT", u8[0], u8.length);
    var codec = pageCodec();
    if (st.pageCodec && codec && typeof codec.send === "function") {
      codec.send(buf);
      return;
    }
    if (!st.worker) return;
    var bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var copy = bytes.slice().buffer;
    st.worker.postMessage({ type: "send", data: copy }, [copy]);
  }

  function sendAuth() {
    if (st.authSent) return;
    st.authSent = true;
    var jwt = readJwt();
    var w = new Writer(8 + jwt.length * 2);
    w.u8(13);
    if (st.server && st.server.mode === "ffa") w.str16u16(jwt);
    else w.str16(jwt);
    if (jwt === "null") status("AUTH — no senpa session, click Discord/Facebook in the menu", true);
    else status("TX AUTH opcode=13");
    log("AUTH", "opcode=13 length=" + w.offset + " stringLength=" + (st.server && st.server.mode === "ffa" ? "UInt16" : "UInt8") + " hasToken=" + (jwt !== "null"));
    sendBuf(w.out());
  }

  function sendNickTagSkin() {
    syncOwnNick();
    var nickEl = document.getElementById(st.controllingTab === 2 ? "nick2" : "nick");
    var nick = ((nickEl || document.getElementById("nick") || {}).value || "player").slice(0, 15);
    var tag = ((document.getElementById("tag") || {}).value || "").slice(0, 10);
    if (tag.indexOf(PEER_ZW) === -1) tag += PEER_ZW;
    var n = new Writer(4 + nick.length * 2);
    n.u8(10);
    n.str16(nick);
    sendBuf(n.out());
    var t = new Writer(4 + tag.length * 2);
    t.u8(11);
    t.str16(tag);
    sendBuf(t.out());
    var s = new Writer(16 + PEER_MARK.length * 2);
    s.u8(21);
    s.u8(0);
    s.str16(PEER_MARK);
    sendBuf(s.out());
  }

  function sendPing() {
    if (!st.authOk) return;
    var w = new Writer(4);
    w.u8(30);
    sendBuf(w.out());
  }

  function isMouseSpectate() {
    return !!document.querySelector("#spectate-mode-mouse.active");
  }

  function isDeadSpectate() {
    if (tabAlive(1) || tabAlive(2)) return false;
    if (st.spectate) return true;
    var cam = st._cam;
    return !!(cam && cam.isSpectating);
  }

  function findCam() {
    if (st._cam && st._cam.spectatePoints && typeof st._cam.x === "number") return st._cam;
    try {
      var names = Object.getOwnPropertyNames(global);
      for (var i = 0; i < names.length; i++) {
        var o = global[names[i]];
        if (o && o.spectatePoints && o.viewBounds && typeof o.x === "number" && typeof o.viewport === "number") {
          st._cam = o;
          return o;
        }
      }
    } catch (_) {}
    return null;
  }

  function specViewport(P) {
    var vp = P && P.rootContainer && P.rootContainer.scale && P.rootContainer.scale.x;
    return vp > 0.01 ? vp : 0.1;
  }

  function captureCamFromRenderer() {
    var P = global.re;
    if (!P || !P.mainContainer || !P.mainContainer.position) return;
    var vp = specViewport(P);
    st.specAgarX = (global.innerWidth >> 1) / vp - P.mainContainer.position.x;
    st.specAgarY = (global.innerHeight >> 1) / vp - P.mainContainer.position.y;
  }

  function wrapRenderer() {
    var P = global.re;
    if (!P || !P.renderer || typeof P.renderer.render !== "function") return;
    if (P.renderer.__hsloSpecRender) return;
    P.renderer.__hsloSpecRender = true;
    var origRender = P.renderer.render.bind(P.renderer);
    P.renderer.render = function (container) {
      if (isSenpaSelected() && isDeadSpectate() && P.mainContainer && P.mainContainer.position) {
        if (st.specHasTarget) {
          st.specAgarX = (29 * st.specAgarX + st.specTargetX) / 30;
          st.specAgarY = (29 * st.specAgarY + st.specTargetY) / 30;
        }
        var vp = specViewport(P);
        P.mainContainer.position.x = (global.innerWidth >> 1) / vp - st.specAgarX;
        P.mainContainer.position.y = (global.innerHeight >> 1) / vp - st.specAgarY;
      }
      return origRender(container);
    };
  }

  function applySpecCamera(agarX, agarY, snap) {
    if (typeof agarX === "number") st.specTargetX = agarX;
    if (typeof agarY === "number") st.specTargetY = agarY;
    st.specHasTarget = true;
    if (snap) {
      st.specAgarX = st.specTargetX;
      st.specAgarY = st.specTargetY;
    }
    var cam = findCam();
    if (cam) {
      cam.isSpectating = true;
      if (cam.spectatePoints) {
        cam.spectatePoints.x = st.specTargetX;
        cam.spectatePoints.y = st.specTargetY;
      }
      if (isMouseSpectate()) cam.freeSpectate = true;
    }
    wrapRenderer();
  }

  function spawnTabWithRetry(tab) {
    requestSpawn(tab);
    if (st.spawnTimer) clearInterval(st.spawnTimer);
    var tries = 0;
    st.spawnTimer = setInterval(function () {
      tries++;
      var want = tab === 2 ? st.wantSpawn2 : st.wantSpawn1;
      if (tabAlive(tab) || !want || tries > 20) {
        clearInterval(st.spawnTimer);
        st.spawnTimer = null;
        return;
      }
      if (st.authOk) sendSpawn(tab);
    }, 400);
  }

  function sendCursor(opts) {
    if (!st.authOk) return;
    opts = opts || {};
    wrapRenderer();
    var spectate = !opts.play && isDeadSpectate();
    if (!opts.keepAim) {
      if (spectate) {
        var agar = screenToAgar(st.lastCx || global.innerWidth / 2, st.lastCy || global.innerHeight / 2);
        var sen = agarToSenpa(agar.x, agar.y);
        st.mouseX = sen.x;
        st.mouseY = sen.y;
      } else {
        refreshMouse();
      }
    }
    var w = new Writer(16);
    w.u8(20);
    w.u8(spectate ? 1 : 0);
    if (!spectate) w.u8(tabByte());
    w.i32(st.mouseX | 0);
    w.i32(st.mouseY | 0);
    sendBuf(w.out());
  }

  function aimAtSpectateView() {
    if (isMouseSpectate()) {
      var agar = screenToAgar(st.lastCx || global.innerWidth / 2, st.lastCy || global.innerHeight / 2);
      var sen = agarToSenpa(agar.x, agar.y);
      st.mouseX = sen.x;
      st.mouseY = sen.y;
      return;
    }
    if (st.viewSenX || st.viewSenY) {
      st.mouseX = st.viewSenX | 0;
      st.mouseY = st.viewSenY | 0;
      return;
    }
    var l = global.classA;
    if (l) {
      var mapped = agarToSenpa(l.x, l.y);
      st.mouseX = mapped.x;
      st.mouseY = mapped.y;
    }
  }

  function ownCellCount(tab) {
    var B = cellStore();
    if (!B) return 0;
    var map = tab === 2 ? B.myCellsTab2 : B.myCellsTab1;
    return map && typeof map.size === "number" ? map.size : 0;
  }

  function syncSpawnFlags() {
    var t1 = ownCellCount(1) > 0;
    var t2 = ownCellCount(2) > 0;
    if (st.spawnedTab1 && !t1) {
      st.wantSpawn1 = false;
      st.play = false;
      if (st.spawnTimer) {
        clearInterval(st.spawnTimer);
        st.spawnTimer = null;
      }
    }
    if (st.spawnedTab2 && !t2) st.wantSpawn2 = false;
    st.spawnedTab1 = t1;
    st.spawnedTab2 = t2;
    st.spawned = t1 || t2;
    var l = global.classA;
    if (l) {
      l.isAliveTab1 = t1;
      l.isAliveTab2 = t2;
    }
  }

  function tabAlive(tab) {
    return ownCellCount(tab) > 0;
  }

  function requestSpawn(tab) {
    tab = tab || 1;
    if (tab === 2) st.wantSpawn2 = true;
    else st.wantSpawn1 = true;
    sendSpawn(tab);
  }

  function sendSpawn(tab) {
    if (!st.authOk) {
      log("GAME", "spawn wait — handshake not accepted");
      return;
    }
    tab = tab || st.controllingTab || 1;
    if (!dualMode()) tab = 1;
    syncSpawnFlags();
    if (tab === 2 ? !st.wantSpawn2 : !st.wantSpawn1) return;
    if (tabAlive(tab)) return;
    var now = Date.now();
    var stampKey = "last" + tab;
    if (now - (sendSpawn[stampKey] || 0) < 350) return;
    sendSpawn[stampKey] = now;
    st.play = true;
    st.spectate = false;
    st.controllingTab = tab;
    syncHudTab();
    if (!(dualMode() && tab === 2 && ownCellCount(1) > 0)) {
      sendNickTagSkin();
    }
    aimAtSpectateView();
    sendCursor({ keepAim: true, play: true });
    sendCursor({ keepAim: true, play: true });
    var w = new Writer(4);
    w.u8(0);
    w.u8(dualMode() ? (tab === 1 ? 0 : 1) : 0);
    log("GAME", "TX SPAWN opcode=0 tab=" + tab + " mode=" + (st.server && st.server.mode) + " pids=" + st.playerIds.join(","));
    sendBuf(w.out());
  }

  function clearSplitTimers() {
    var i;
    var list = st.splitTimers || [];
    for (i = 0; i < list.length; i++) clearTimeout(list[i]);
    st.splitTimers = [];
  }

  function sendSplit(ownerTab) {
    var tab = ownerTab || st.controllingTab || 1;
    if (!st.authOk) return;
    syncSpawnFlags();
    if (tab === 2) {
      if (!st.spawnedTab2 && !tabAlive(2)) return;
    } else if (!st.spawnedTab1 && !tabAlive(1)) {
      return;
    }
    var opId = "split-" + (++st.splitOp);
    mbLog(tab, "split", opId);
    if (tab === st.controllingTab) sendCursor();
    var w = new Writer(8);
    w.u8(22);
    w.u8(tabByteFor(tab));
    w.u8(1);
    log("GAME", "TX SPLIT botId=" + tab + " activeBot=" + st.controllingTab + " mouse=" + (st.mouseX | 0) + "," + (st.mouseY | 0));
    sendBuf(w.out());
  }

  function queueOwnedSplit(ownerTab, delayMs) {
    var tab = ownerTab;
    var tid = setTimeout(function () {
      sendSplit(tab);
    }, delayMs);
    if (!st.splitTimers) st.splitTimers = [];
    st.splitTimers.push(tid);
  }

  function splitBurst(times) {
    var tab = st.controllingTab || 1;
    var gap = feedIntervalMs();
    sendSplit(tab);
    var n;
    for (n = 1; n < times; n++) queueOwnedSplit(tab, gap * n);
  }

  function feedIntervalMs() {
    try {
      var store = global.c;
      if (store && typeof store.get === "function") {
        var n = +store.get("settings", "splitEjectInterval");
        if (n >= 1 && n <= 200) return n;
      }
    } catch (_) {}
    return 40;
  }

  function sendFeed(opts) {
    if (!st.authOk) return;
    if (!(opts && opts.skipCursor)) sendCursor();
    var w = new Writer(8);
    w.u8(23);
    w.u8(tabByte());
    w.u8(0);
    sendBuf(w.out());
  }

  function startMacroFeed() {
    if (st.macroTimer) return;
    sendFeed();
    st.macroTimer = setInterval(function () {
      sendFeed({ skipCursor: true });
    }, feedIntervalMs());
  }

  function stopMacroFeed() {
    if (st.macroTimer) {
      clearInterval(st.macroTimer);
      st.macroTimer = null;
    }
  }

  function ffaAlloc(code, data) {
    var codec = pageCodec();
    if (codec && typeof codec.alloc === "function") return codec.alloc(code, data);
    if (st.worker) {
      var bytes = data instanceof Uint8Array ? data : new Uint8Array(data || 0);
      var copy = bytes.slice().buffer;
      st.worker.postMessage({ type: "alloc", code: code, data: copy }, [copy]);
      return true;
    }
    return false;
  }

  function flushWasmAlloc() {
    try {
      var track = global.CanvasCaptureMediaStreamTrack;
      if (track && track.contextBufferFactory) {
        ffaAlloc(9, track.contextBufferFactory);
        track.contextBufferFactory = null;
      }
    } catch (err) {
      log("ERROR", "ALLOC_9 " + (err && err.message ? err.message : err));
    }
  }

  function cellStore() {
    return global.classI || null;
  }

  function gameTime() {
    return Date.now();
  }

  function senpaToAgar(x, y) {
    var b = st.border > 0 ? st.border : AGAR_EDGE;
    return {
      x: (x * AGAR_EDGE) / b - AGAR_EDGE / 2,
      y: (y * AGAR_EDGE) / b - AGAR_EDGE / 2
    };
  }

  function senpaSize(size) {
    var b = st.border > 0 ? st.border : AGAR_EDGE;
    return (size * AGAR_EDGE) / b;
  }

  function senpaMassFromRadius(radius) {
    var r = +radius || 0;
    var b = st.border > 0 ? st.border : AGAR_EDGE;
    var raw = (r * b) / AGAR_EDGE;
    return 0 | (raw * raw / 100);
  }

  function patchCellMass(cell) {
    if (!cell || st.massProto) return;
    var proto = cell;
    var massDesc = null;
    var staticDesc = null;
    while (proto && proto !== Object.prototype) {
      massDesc = Object.getOwnPropertyDescriptor(proto, "mass");
      if (massDesc && typeof massDesc.get === "function") {
        staticDesc = Object.getOwnPropertyDescriptor(proto, "staticMass");
        break;
      }
      proto = Object.getPrototypeOf(proto);
    }
    if (!massDesc || typeof massDesc.get !== "function") return;
    st.massProto = proto;
    var origMass = massDesc.get;
    var origStatic = staticDesc && staticDesc.get;
    Object.defineProperty(proto, "mass", {
      configurable: true,
      enumerable: massDesc.enumerable,
      get: function () {
        if (isSenpaSelected() && st.border > 0) return senpaMassFromRadius(this.animRadius);
        return origMass.call(this);
      }
    });
    if (origStatic) {
      Object.defineProperty(proto, "staticMass", {
        configurable: true,
        enumerable: staticDesc.enumerable,
        get: function () {
          if (isSenpaSelected() && st.border > 0) return senpaMassFromRadius(this.radius);
          return origStatic.call(this);
        }
      });
    }
  }

  function agarToSenpa(x, y) {
    var b = st.border > 0 ? st.border : AGAR_EDGE;
    return {
      x: Math.round(((x + AGAR_EDGE / 2) * b) / AGAR_EDGE),
      y: Math.round(((y + AGAR_EDGE / 2) * b) / AGAR_EDGE)
    };
  }

  function ownRadiusSum(tab) {
    var B = cellStore();
    if (!B) return 0;
    var map = tab === 2 ? B.myCellsTab2 : B.myCellsTab1;
    var n = 0;
    if (map && typeof map.forEach === "function") {
      map.forEach(function (c) {
        n += c.animRadius || c.radius || 0;
      });
    }
    return n;
  }

  function screenToAgar(cx, cy) {
    var l = global.classA;
    var camX;
    var camY;
    if (isDeadSpectate()) {
      camX = st.specAgarX;
      camY = st.specAgarY;
    } else {
      camX = l ? l.x : 0;
      camY = l ? l.y : 0;
    }
    var n = ownRadiusSum(st.controllingTab === 2 ? 2 : 1);
    if (!(n > 0)) n = ownRadiusSum(1) + ownRadiusSum(2);
    if (!(n > 0)) n = 64;
    var viewport = Math.pow(Math.min(64 / n, 1), 0.4) * Math.max(global.innerWidth / 1920, global.innerHeight / 1080);
    if (isDeadSpectate()) {
      var P = global.re;
      var vp = P && P.rootContainer && P.rootContainer.scale && P.rootContainer.scale.x;
      viewport = vp > 0.02 ? vp : 0.1;
    }
    if (!(viewport > 0.02)) viewport = 0.02;
    return {
      x: (cx - global.innerWidth / 2) / viewport + camX,
      y: (cy - global.innerHeight / 2) / viewport + camY
    };
  }

  function readAgarMouse() {
    var l = global.classA;
    var tab = st.controllingTab || 1;
    if (l && l.cursor && l.cursor[tab]) {
      var cx = +l.cursor[tab].x;
      var cy = +l.cursor[tab].y;
      if (cx !== 0 || cy !== 0) return { x: cx, y: cy };
    }
    return screenToAgar(st.lastCx, st.lastCy);
  }

  function refreshMouse() {
    var agar = readAgarMouse();
    var sen = agarToSenpa(agar.x, agar.y);
    st.mouseX = sen.x;
    st.mouseY = sen.y;
  }

  function syncOwnNick() {
    var l = global.classA;
    if (!l) return;
    var nick = ((document.getElementById("nick") || {}).value || "player").slice(0, 15);
    var nick2 = ((document.getElementById("nick2") || {}).value || nick).slice(0, 15);
    try {
      if (l.nick !== nick) l.nick = nick;
    } catch (_) {}
    try {
      if (l.nick2 !== nick2) l.nick2 = nick2;
    } catch (_) {}
  }

  function syncHudTab() {
    try {
      var l = global.classA;
      if (l) l.controllingTab = st.controllingTab;
    } catch (_) {}
  }

  function tabForPid(pid) {
    if (!dualMode()) return 1;
    var ids = st.playerIds || [];
    if (!ids.length) return 1;
    if (pid === ids[0]) return 1;
    var idx = ids.indexOf(pid);
    if (idx >= 1) return 2;
    if (isOwnPid(pid) && pid !== ids[0]) return 2;
    return 1;
  }

  function snapCamera(x, y) {
    var l = global.classA;
    if (!l) return;
    l.x = x;
    l.y = y;
    if (st.controllingTab === 2) {
      l.x2 = x;
      l.y2 = y;
    } else {
      l.x1 = x;
      l.y1 = y;
    }
  }

  function setCellColor(cell, r, g, b) {
    if (!cell || !cell.colorObject || typeof cell.colorObject.set !== "function") return;
    try {
      cell.colorObject.set(r, g, b);
    } catch (_) {}
  }

  function isUsableSkin(raw) {
    if (!raw || typeof raw !== "string") return false;
    var s = raw.trim();
    if (!s) return false;
    if (/^https?:\/\//i.test(s)) return true;
    if (s.toLowerCase().indexOf("imgur") !== -1) return true;
    if (s.indexOf(PEER_MARK) !== -1) return false;
    return false;
  }

  function applyPlayerMeta(cell, pid) {
    if (!cell || !pid) return;
    cell.parentPlayerID = pid;
    var pl = st.players[pid];
    if (!pl) return;
    if (isUsableSkin(pl.skin)) cell.skin = pl.skin;
    else if (cell.skin && !isUsableSkin(cell.skin)) cell.skin = "";
    var cl = st.clients[pl.clientId];
    if (!cl) return;
    if (cl.nick) cell.nick = String(cl.nick).split(PEER_ZW).join("");
    else if (!cell.nick) cell.nick = "Unnamed";
    if (cl.tag) cell.tag = String(cl.tag).split(PEER_ZW).join("");
  }

  function patchNoSkinPlaceholder() {
    var c = global.c;
    if (c && !c.__hsloEveryoneHook) {
      try {
        var held = c.everyoneSkins;
        c.__hsloEveryoneHook = true;
        Object.defineProperty(c, "everyoneSkins", {
          configurable: true,
          enumerable: true,
          get: function () {
            if (isSenpaSelected()) return "off";
            return c._hsloEveryoneSkins;
          },
          set: function (v) {
            c._hsloEveryoneSkins = v;
          }
        });
        c._hsloEveryoneSkins = held;
      } catch (_) {}
    }
  }

  function isHsloPeerMark(value) {
    var s = value == null ? "" : String(value);
    if (!s) return false;
    if (s.indexOf(PEER_MARK) !== -1) return true;
    if (s.indexOf(PEER_ZW) !== -1) return true;
    return false;
  }

  function isHsloPeerPid(pid) {
    if (!pid || isOwnPid(pid)) return false;
    var pl = st.players[pid];
    if (pl && isHsloPeerMark(pl.skin)) return true;
    var cl = pl && st.clients[pl.clientId];
    if (cl && isHsloPeerMark(cl.tag)) return true;
    if (cl && isHsloPeerMark(cl.skin)) return true;
    return false;
  }

  function peerColor(pid) {
    var pl = st.players[pid];
    var cl = pl && st.clients[pl.clientId];
    if (cl && typeof cl.r === "number") return "rgb(" + (cl.r | 0) + "," + (cl.g | 0) + "," + (cl.b | 0) + ")";
    if (pl && typeof pl.r === "number") return "rgb(" + (pl.r | 0) + "," + (pl.g | 0) + "," + (pl.b | 0) + ")";
    try {
      if (global.f && global.f.teammateColor) return global.f.teammateColor;
    } catch (_) {}
    return "#7dffb0";
  }

  function peerKey(pid) {
    var pl = st.players[pid];
    if (pl && pl.clientId) return "c" + pl.clientId;
    return "p" + pid;
  }

  function cleanPeerNick(raw) {
    return String(raw || "")
      .split(PEER_ZW)
      .join("")
      .split(PEER_MARK)
      .join("")
      .trim();
  }

  function refreshPeersFromCells() {
    if (!isSenpaSelected() || !st.authOk) return;
    var acc = Object.create(null);
    function walk(map) {
      if (!map || typeof map.forEach !== "function") return;
      map.forEach(function (cell) {
        if (!cell || cell.isFood || cell.isVirus || cell.isEjected) return;
        var pid = cell.parentPlayerID;
        if (!pid || isOwnPid(pid) || !isHsloPeerPid(pid)) return;
        var key = peerKey(pid);
        var row = acc[key];
        if (!row) {
          acc[key] = { x: cell.x, y: cell.y, n: 1, pid: pid };
          return;
        }
        row.x += cell.x;
        row.y += cell.y;
        row.n++;
      });
    }
    var B = cellStore();
    if (B) {
      walk(B.cellsTab1);
      walk(B.cellsTab2);
    }
    var key;
    for (key in acc) {
      if (!Object.prototype.hasOwnProperty.call(acc, key)) continue;
      var a = acc[key];
      var pl = st.players[a.pid];
      var cl = pl && st.clients[pl.clientId];
      var prev = st.peers[key] || {};
      st.peers[key] = {
        x: a.x / a.n,
        y: a.y / a.n,
        nick: cleanPeerNick((cl && cl.nick) || prev.nick || ""),
        color: peerColor(a.pid),
        seen: Date.now()
      };
    }
  }

  function ensurePeerMapCanvas() {
    var base = document.getElementById("minimap-nodes");
    if (!base) return null;
    var ov = document.getElementById("hslo-peer-map");
    if (!ov) {
      ov = document.createElement("canvas");
      ov.id = "hslo-peer-map";
      ov.style.cssText =
        "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:6;";
      var parent = base.parentNode;
      if (parent) {
        var pos = parent.style && parent.style.position;
        if (!pos) {
          try {
            if (global.getComputedStyle(parent).position === "static") parent.style.position = "relative";
          } catch (_) {
            parent.style.position = "relative";
          }
        }
        parent.appendChild(ov);
      }
    }
    var w = base.width || base.clientWidth || 200;
    var h = base.height || base.clientHeight || 200;
    if (ov.width !== w) ov.width = w;
    if (ov.height !== h) ov.height = h;
    ov.style.width = (base.clientWidth || w) + "px";
    ov.style.height = (base.clientHeight || h) + "px";
    return ov;
  }

  function drawHsloPeersOnMinimap() {
    var ov = ensurePeerMapCanvas();
    if (!ov) return;
    var ctx = ov.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, ov.width, ov.height);
    if (!isSenpaSelected() || !st.authOk) return;
    var now = Date.now();
    var ratio = ov.width / AGAR_EDGE;
    var half = AGAR_EDGE / 2;
    var pid;
    for (pid in st.peers) {
      if (!Object.prototype.hasOwnProperty.call(st.peers, pid)) continue;
      var p = st.peers[pid];
      if (!p || now - p.seen > 12000) {
        delete st.peers[pid];
        continue;
      }
      var px = (half + p.x) * ratio;
      var py = (half + p.y) * ratio;
      ctx.save();
      ctx.fillStyle = p.color || "#7dffb0";
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(px, py, 4.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (p.nick) {
        ctx.font = "700 9px Ubuntu,Segoe UI,sans-serif";
        ctx.textAlign = "center";
        ctx.lineWidth = 2.4;
        ctx.strokeStyle = "rgba(0,0,0,0.7)";
        ctx.strokeText(p.nick, px, py - 7);
        ctx.fillStyle = "#fff";
        ctx.fillText(p.nick, px, py - 7);
      }
      ctx.restore();
    }
  }

  function peerMapTick() {
    st.peerMapRaf = 0;
    drawHsloPeersOnMinimap();
    if (st.authOk && isSenpaSelected()) {
      st.peerMapRaf = global.requestAnimationFrame(peerMapTick);
    }
  }

  function startPeerMapLoop() {
    if (st.peerMapRaf) return;
    st.peerMapRaf = global.requestAnimationFrame(peerMapTick);
  }

  function stopPeerMapLoop() {
    if (st.peerMapRaf) {
      try {
        global.cancelAnimationFrame(st.peerMapRaf);
      } catch (_) {}
      st.peerMapRaf = 0;
    }
    st.peers = Object.create(null);
    var ov = document.getElementById("hslo-peer-map");
    if (ov) {
      try {
        ov.getContext("2d").clearRect(0, 0, ov.width, ov.height);
      } catch (_) {}
    }
  }

  function findCell(id) {
    var B = cellStore();
    if (!B) return null;
    var c1 = B.cellsTab1 && B.cellsTab1.get && B.cellsTab1.get(id);
    if (c1) return c1;
    var c2 = B.cellsTab2 && B.cellsTab2.get && B.cellsTab2.get(id);
    if (c2) return c2;
    return null;
  }

  function refreshCellMeta() {
    var B = cellStore();
    if (!B) return;
    function applyMap(map) {
      if (!map || typeof map.forEach !== "function") return;
      map.forEach(function (cell) {
        if (cell && cell.parentPlayerID) applyPlayerMeta(cell, cell.parentPlayerID);
      });
    }
    applyMap(B.cellsTab1);
    applyMap(B.cellsTab2);
  }

  function markOwnCell(id, tab) {
    var B = cellStore();
    if (!B) return;
    var set = tab === 2 ? B.cellsIDTab2 : B.cellsIDTab1;
    if (set && typeof set.add === "function") set.add(id);
  }

  function getOrAddCell(id, mine, tab) {
    var B = cellStore();
    if (!B || typeof B.addCell !== "function") return null;
    var existing = findCell(id);
    if (existing) {
      var ownerTab = existing.tab === 2 ? 2 : 1;
      if (mine && !existing.isMine) {
        markOwnCell(id, ownerTab);
        if (typeof B.myCellCheck === "function") B.myCellCheck(id, existing, ownerTab);
        var existMine = ownerTab === 2 ? B.myCellsTab2 : B.myCellsTab1;
        if (existMine && typeof existMine.set === "function" && !existMine.has(id)) existMine.set(id, existing);
        existing.isMine = true;
      }
      return existing;
    }
    tab = tab === 2 ? 2 : 1;
    var map = tab === 2 ? B.cellsTab2 : B.cellsTab1;
    var mineMap = tab === 2 ? B.myCellsTab2 : B.myCellsTab1;
    var cell = map && map.get && map.get(id);
    if (cell) {
      if (mine && !cell.isMine && typeof B.myCellCheck === "function") {
        markOwnCell(id, tab);
        B.myCellCheck(id, cell, tab);
      }
      return cell;
    }
    if (mine) markOwnCell(id, tab);
    cell = B.addCell(id, tab);
    if (mine && cell && mineMap && typeof mineMap.set === "function" && !mineMap.has(id)) {
      mineMap.set(id, cell);
      cell.isMine = true;
    }
    return cell;
  }

  function placeCell(cell, x, y, size, kind, mine, rgb, pid) {
    if (!cell) return;
    var now = gameTime();
    if (cell.init) {
      cell.animX = cell.x;
      cell.animY = cell.y;
      cell._000308 = cell.animRadius;
    } else {
      cell.animX = x;
      cell.animY = y;
      cell.animRadius = size;
      cell._000308 = size;
    }
    cell.x = x;
    cell.y = y;
    cell.staticX = x;
    cell.staticY = y;
    cell.radius = size;
    if (!cell.init) cell.animRadius = size;
    patchCellMass(cell);
    cell.lastUpdateTime = now;
    cell.init = true;
    cell.isMine = cell.isMine || !!mine;
    cell.isFood = kind === 1;
    cell.isVirus = kind === 2;
    cell.isEjected = kind === 3;
    if (pid) applyPlayerMeta(cell, pid);
    if (cell.skin && !isUsableSkin(cell.skin)) cell.skin = "";
    if (!cell.nick) {
      if (mine) {
        var l = global.classA;
        cell.nick = (tabForPid(pid) === 2 ? (l && l.nick2) : (l && l.nick)) || "player";
      } else {
        cell.nick = "Unnamed";
      }
    }
    if (rgb) setCellColor(cell, rgb.r, rgb.g, rgb.b);
    if (mine && tabForPid(pid) === st.controllingTab && ownCellCount(tabForPid(pid)) <= 1) {
      snapCamera(x, y);
    }
  }

  function upsertCell(id, x, y, size, kind, mine, rgb, pid) {
    var existing = findCell(id);
    var tab;
    if (existing) tab = existing.tab === 2 ? 2 : 1;
    else tab = mine || kind === 0 ? tabForPid(pid) : 1;
    var cell = getOrAddCell(id, mine, tab);
    placeCell(cell, x, y, size, kind, mine, rgb, pid);
  }

  function deleteCell(id) {
    var B = cellStore();
    if (!B) return;
    try {
      if (B.cellsTab1 && B.cellsTab1.delete) B.cellsTab1.delete(id);
      if (B.cellsTab2 && B.cellsTab2.delete) B.cellsTab2.delete(id);
      if (B.cellsIDTab1 && B.cellsIDTab1.delete) B.cellsIDTab1.delete(id);
      if (B.cellsIDTab2 && B.cellsIDTab2.delete) B.cellsIDTab2.delete(id);
      if (B.myCellsTab1 && B.myCellsTab1.delete) B.myCellsTab1.delete(id);
      if (B.myCellsTab2 && B.myCellsTab2.delete) B.myCellsTab2.delete(id);
    } catch (_) {}
    syncSpawnFlags();
  }

  function clearCells() {
    var B = cellStore();
    if (!B) return;
    try {
      if (B.cellsTab1 && B.cellsTab1.clear) B.cellsTab1.clear();
      if (B.cellsTab2 && B.cellsTab2.clear) B.cellsTab2.clear();
      if (B.cellsIDTab1 && B.cellsIDTab1.clear) B.cellsIDTab1.clear();
      if (B.cellsIDTab2 && B.cellsIDTab2.clear) B.cellsIDTab2.clear();
      if (B.myCellsTab1 && B.myCellsTab1.clear) B.myCellsTab1.clear();
      if (B.myCellsTab2 && B.myCellsTab2.clear) B.myCellsTab2.clear();
    } catch (_) {}
  }

  function isOwnPid(pid) {
    if (st.playerIds.indexOf(pid) !== -1) return true;
    if (st.clientId && pid === st.clientId) return true;
    var rec = st.players[pid];
    if (rec) {
      if (st.clientId && rec.clientId === st.clientId) return true;
      if (st.playerIds.indexOf(rec.clientId) !== -1) return true;
    }
    return false;
  }

  function handleOpcode10(r) {
    var i;
    var add = r.u8();
    for (i = 0; i < add; i++) {
      var id = r.u16();
      var isBot = !!r.u8();
      var nick = r.str16();
      var tag = r.str16();
      var cr = r.u8();
      var cg = r.u8();
      var cb = r.u8();
      var clan = r.i8();
      st.clients[id] = {
        clientId: id,
        isBot: isBot,
        nick: nick,
        tag: tag,
        r: cr,
        g: cg,
        b: cb,
        clan: clan
      };
    }
    var upd = r.u8();
    for (i = 0; i < upd; i++) {
      var uid = r.u16();
      var flags = r.u8();
      var row = st.clients[uid];
      if (!row) {
        row = { clientId: uid, nick: "", tag: "", r: 255, g: 255, b: 255, clan: 0 };
        st.clients[uid] = row;
      }
      if (flags & 1) row.nick = r.str16();
      if (flags & 2) row.tag = r.str16();
      if (flags & 4) {
        row.r = r.u8();
        row.g = r.u8();
        row.b = r.u8();
        r.u8();
      }
    }
    var del = r.u8();
    for (i = 0; i < del; i++) delete st.clients[r.u16()];
    refreshCellMeta();
    refreshPeersFromCells();
  }

  function adoptOwnCells() {
    var B = cellStore();
    if (!B || !B.cellsTab1 || typeof B.cellsTab1.forEach !== "function") return;
    var toMove = [];
    B.cellsTab1.forEach(function (cell, id) {
      var pid = cell.parentPlayerID;
      if (!pid || !isOwnPid(pid)) return;
      if (tabForPid(pid) === 2) toMove.push({ id: id, cell: cell, pid: pid });
    });
    for (var i = 0; i < toMove.length; i++) {
      var m = toMove[i];
      try {
        if (B.cellsTab1) B.cellsTab1.delete(m.id);
        if (B.myCellsTab1) B.myCellsTab1.delete(m.id);
      } catch (_) {}
      var cell = getOrAddCell(m.id, true, 2);
      if (cell && m.cell) {
        placeCell(cell, m.cell.x, m.cell.y, m.cell.radius, 0, true, null, m.pid);
      }
    }
    syncSpawnFlags();
  }

  function handleOpcode11(r) {
    var i;
    var add = r.u8();
    for (i = 0; i < add; i++) {
      var pid = r.u16();
      var cid = r.u16();
      var pr = r.u8();
      var pg = r.u8();
      var pb = r.u8();
      var skin = r.str8();
      st.players[pid] = { playerId: pid, clientId: cid, r: pr, g: pg, b: pb, skin: skin };
      if (st.clientId && cid === st.clientId && st.playerIds.indexOf(pid) === -1) {
        st.playerIds.push(pid);
      }
      if (!st.identityLogged && (isOwnPid(pid) || (st.clientId && cid === st.clientId))) {
        st.identityLogged = true;
        log("GAME", "IDENTITY pid=" + pid + " clientId=" + cid);
      }
    }
    var upd = r.u8();
    for (i = 0; i < upd; i++) {
      var upid = r.u16();
      var uflags = r.u8();
      var prow = st.players[upid];
      if (!prow) {
        prow = { playerId: upid, clientId: 0, r: 255, g: 255, b: 255, skin: "" };
        st.players[upid] = prow;
      }
      if (uflags & 1) {
        prow.r = r.u8();
        prow.g = r.u8();
        prow.b = r.u8();
      }
      if (uflags & 2) prow.skin = r.str8();
    }
    var delp = r.u8();
    for (i = 0; i < delp; i++) delete st.players[r.u16()];
    refreshCellMeta();
    adoptOwnCells();
    refreshPeersFromCells();
    if (st.wantSpawn1 && st.authOk && !tabAlive(1)) sendSpawn(1);
  }

  function handleOpcode20(r) {
    var i;
    var eatCount = r.u16();
    for (i = 0; i < eatCount; i++) {
      r.u32();
      deleteCell(r.u32());
    }
    var addCount = r.u16();
    for (i = 0; i < addCount; i++) {
      var id = r.u32();
      if (id === 0) break;
      var raw = senpaToAgar(r.i32(), r.i32());
      var size = senpaSize(r.u16());
      var kind = r.u8();
      var rgb = null;
      var pid = 0;
      var mine = false;
      if (kind === 0) {
        pid = r.u16();
        rgb = { r: r.u8(), g: r.u8(), b: r.u8() };
        mine = isOwnPid(pid);
        if (mine) {
          var spawnTab = tabForPid(pid);
          if (spawnTab === 2) st.spawnedTab2 = true;
          else st.spawnedTab1 = true;
          st.spawned = true;
          syncOwnNick();
          if (st.spawnTimer && (spawnTab === 1 || spawnTab === 2)) {
            if (tabAlive(spawnTab)) {
              clearInterval(st.spawnTimer);
              st.spawnTimer = null;
            }
          }
          status("SPAWN OK tab=" + spawnTab + " cell " + id + " pid=" + pid);
        }
      } else if (kind === 2) {
        rgb = { r: r.u8(), g: r.u8(), b: r.u8() };
      } else if (kind === 5) {
        var blobLen = r.u16();
        var blob = new Uint8Array(blobLen);
        for (var bi = 0; bi < blobLen; bi++) blob[bi] = r.u8();
        ffaAlloc(8, blob);
      }
      upsertCell(id, raw.x, raw.y, size, kind, mine, rgb, pid);
    }
    var updCount = r.u16();
    for (i = 0; i < updCount; i++) {
      var uid = r.u32();
      var pos = senpaToAgar(r.i32(), r.i32());
      var ur = senpaSize(r.u16());
      var B = cellStore();
      var cell =
        (B && B.cellsTab1 && B.cellsTab1.get && B.cellsTab1.get(uid)) ||
        (B && B.cellsTab2 && B.cellsTab2.get && B.cellsTab2.get(uid));
      if (cell) {
        cell.animX = cell.x;
        cell.animY = cell.y;
        cell._000308 = cell.animRadius;
        cell.staticX = pos.x;
        cell.staticY = pos.y;
        cell.x = pos.x;
        cell.y = pos.y;
        cell.radius = ur;
        patchCellMass(cell);
        cell.lastUpdateTime = gameTime();
        if (cell.isMine && cell.tab === st.controllingTab) snapCamera(pos.x, pos.y);
      }
    }
    var delCount = r.u16();
    for (i = 0; i < delCount; i++) deleteCell(r.u32());
    if (r.left() === 4) {
      var border = r.u32();
      if (border > 8000 && border < 80000) st.border = border;
    }
    syncSpawnFlags();
    flushWasmAlloc();
    refreshPeersFromCells();
  }

  function handleOpcode21(r) {
    if (r.left() > 0) r.u8();
    var names = [];
    while (r.left() >= 6 && names.length < 20) {
      var cid = r.u16();
      var mass = r.u32();
      var cl = st.clients[cid];
      names.push({ nick: (cl && cl.nick) || "unnamed", mass: mass });
    }
    var nodes = document.querySelectorAll("#leaderboard-positions .lb-position");
    for (var i = 0; i < nodes.length; i++) {
      var nameEl = nodes[i].querySelector('[lbData="name"]');
      if (!nameEl) continue;
      nameEl.textContent = i < names.length ? names[i].nick : "";
    }
    var massEl = document.querySelector('#leaderboard-positions [lbData="dataMass"]');
    if (massEl && names.length) {
      var top = 0;
      for (var m = 0; m < names.length && m < 20; m++) top += names[m].mass;
      massEl.textContent = String(top);
    }
  }

  function startLoop() {
    if (st.pingTimer) clearInterval(st.pingTimer);
    if (st.cursorTimer) clearInterval(st.cursorTimer);
    muteCommanderPing();
    wrapRenderer();
    patchNoSkinPlaceholder();
    startPeerMapLoop();
    st.pingTimer = setInterval(sendPing, 1000);
    st.cursorTimer = setInterval(sendCursor, 50);
  }

  function stopLoop() {
    if (st.pingTimer) clearInterval(st.pingTimer);
    if (st.cursorTimer) clearInterval(st.cursorTimer);
    if (st.spawnTimer) clearInterval(st.spawnTimer);
    if (st.handshakeTimer) clearTimeout(st.handshakeTimer);
    stopMacroFeed();
    clearSplitTimers();
    stopPeerMapLoop();
    st.pingTimer = null;
    st.cursorTimer = null;
    st.spawnTimer = null;
    st.handshakeTimer = null;
  }

  function onMessage(data) {
    var u8 = toU8(data);
    if (!u8 || !u8.length) return;
    try {
      var r = new Reader(new DataView(u8.buffer, u8.byteOffset, u8.byteLength));
      var op = r.u8();
      packetLog("IN", op, u8.length);
      if (op === 8) {
        status("server asked AUTH (opcode 8)");
        log("HANDSHAKE", "RX opcode=8");
        sendAuth();
        return;
      }
      if (op === 0) {
        st.border = r.u32();
        st.clientId = r.u16();
        var nTabs = r.u8();
        st.playerIds = [];
        for (var t = 0; t < nTabs; t++) st.playerIds.push(r.u16());
        st.authOk = true;
        if (st.handshakeTimer) {
          clearTimeout(st.handshakeTimer);
          st.handshakeTimer = null;
        }
        st.reconnectMs = RECONNECT_BASE_MS;
        st.reconnectLeft = RECONNECT_TRIES;
        st.mouseX = (st.border / 2) | 0;
        st.mouseY = (st.border / 2) | 0;
        var mid = senpaToAgar(st.mouseX, st.mouseY);
        st.specAgarX = mid.x;
        st.specAgarY = mid.y;
        st.specTargetX = mid.x;
        st.specTargetY = mid.y;
        st.specHasTarget = true;
        if (st.spectate) applySpecCamera(mid.x, mid.y, true);
        log("HANDSHAKE", "OK clientId=" + st.clientId + " tabs=" + nTabs + " pids=[" + st.playerIds.join(",") + "] border=" + st.border + " mode=" + (st.server && st.server.mode));
        status("HANDSHAKE OK " + (st.server && st.server.label) + " clientId=" + st.clientId);
        sendNickTagSkin();
        startLoop();
        if (st.wantSpawn1) sendSpawn(1);
        return;
      }
      if (op === 1) {
        st.border = r.u32();
        return;
      }
      if (op === 7) {
        status("server captcha opcode=7 — login on senpa.io then reload", true);
        return;
      }
      if (op === 10) {
        handleOpcode10(r);
        return;
      }
      if (op === 11) {
        handleOpcode11(r);
        return;
      }
      if (op === 20) {
        handleOpcode20(r);
        return;
      }
      if (op === 21) {
        handleOpcode21(r);
        return;
      }
      if (op === 23) {
        var sx = r.i32();
        var sy = r.i32();
        st.viewSenX = sx;
        st.viewSenY = sy;
        var spec = senpaToAgar(sx, sy);
        if (isDeadSpectate()) applySpecCamera(spec.x, spec.y);
      }
    } catch (err) {
      log("ERROR", "packet parse " + (err && err.message ? err.message : err));
    }
  }

  function resetSession() {
    stopLoop();
    st.authOk = false;
    st.authSent = false;
    st.spawned = false;
    st.spawnedTab1 = false;
    st.spawnedTab2 = false;
    st.controllingTab = 1;
    st.socketOpen = false;
    st.connecting = false;
    st.rxLog = 0;
    st.txLog = 0;
    st.clientId = 0;
    st.playerIds = [];
    st.border = 0;
    st.players = Object.create(null);
    st.clients = Object.create(null);
    st.peers = Object.create(null);
    st.identityLogged = false;
    sendSpawn.last = 0;
    sendSpawn.last1 = 0;
    sendSpawn.last2 = 0;
    global.__HSLO_SENPA_CONNECTED__ = false;
  }

  function restoreWsHook() {
    st.allowNative = false;
    global.__HSLO_ALLOW_SENPA_WS__ = false;
    global.__HSLO_ALLOW_FFA_WS__ = false;
    if (NativeWS && global.WebSocket !== NativeWS) global.WebSocket = NativeWS;
  }

  function armNative() {
    st.allowNative = true;
    global.__HSLO_ALLOW_SENPA_WS__ = true;
    global.__HSLO_ALLOW_FFA_WS__ = true;
    if (NativeWS) global.WebSocket = NativeWS;
  }

  function killConnection() {
    st.suppressReconnect = true;
    st.gen += 1;
    if (st.reconnectTimer) {
      clearTimeout(st.reconnectTimer);
      st.reconnectTimer = null;
    }
    stopLoop();
    st.workerReady = false;
    st.socketOpen = false;
    st.connecting = false;
    st.pageCodec = false;
    restoreWsHook();
    var codec = pageCodec();
    if (codec && typeof codec.close === "function") {
      try {
        codec.close();
      } catch (_) {}
    }
    if (st.worker) {
      try {
        st.worker.postMessage({ type: "close" });
      } catch (_) {}
      try {
        st.worker.terminate();
      } catch (_) {}
      st.worker = null;
    }
  }

  function disconnect(reason) {
    log("DISCONNECT", reason || "manual");
    killConnection();
    resetSession();
    clearCells();
    status("disconnected");
  }

  function scheduleReconnect(reason) {
    if (!isSenpaSelected()) {
      status((reason || "disconnected") + " — senpa not selected", true);
      return;
    }
    if (st.reconnectLeft <= 0) {
      status((reason || "disconnected") + " — retries exhausted", true);
      return;
    }
    st.reconnectLeft -= 1;
    var wait = st.reconnectMs;
    st.reconnectMs = Math.min(st.reconnectMs * 2, RECONNECT_MAX_MS);
    status((reason || "disconnected") + " — reconnect in " + wait + "ms (" + st.reconnectLeft + " left)");
    log("RECONNECT", "wait=" + wait + " left=" + st.reconnectLeft);
    st.reconnectTimer = setTimeout(function () {
      st.reconnectTimer = null;
      connectSelected("reconnect");
    }, wait);
  }

  function makeFakeSocket(url) {
    var listeners = { open: [], message: [], close: [], error: [] };
    var ws = {
      url: String(url),
      protocol: "",
      extensions: "",
      binaryType: "arraybuffer",
      bufferedAmount: 0,
      readyState: 0,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: function () {},
      close: function (code, reason) {
        if (ws.readyState === 3) return;
        ws.readyState = 3;
        var ev = { type: "close", code: code || 1000, reason: reason || "", wasClean: true };
        if (typeof ws.onclose === "function") ws.onclose(ev);
        listeners.close.forEach(function (fn) {
          try {
            fn(ev);
          } catch (_) {}
        });
      },
      addEventListener: function (type, fn) {
        if (listeners[type]) listeners[type].push(fn);
      },
      removeEventListener: function (type, fn) {
        if (!listeners[type]) return;
        listeners[type] = listeners[type].filter(function (x) {
          return x !== fn;
        });
      },
      dispatchEvent: function () {
        return true;
      }
    };
    queueMicrotask(function () {
      if (ws.readyState !== 0) return;
      ws.readyState = 1;
      var ev = { type: "open" };
      if (typeof ws.onopen === "function") ws.onopen(ev);
      listeners.open.forEach(function (fn) {
        try {
          fn(ev);
        } catch (_) {}
      });
    });
    return ws;
  }

  function isSenpaGameUrl(url) {
    var raw = String(url || "");
    return catalog.isAllowedWsUrl(raw) || catalog.isCatalogHost(raw) || /senpa\.io:\d+/i.test(raw);
  }

  function hookWebSocket() {
    if (hookWebSocket.done) return true;
    if (global.__HSLO_NATIVE_WS__) NativeWS = global.__HSLO_NATIVE_WS__;
    else if (global.WebSocket && !global.WebSocket.__hsloSenpaHook) NativeWS = global.WebSocket;
    if (!NativeWS) return false;
    function Wrapped(url, protocols) {
      if (isSenpaGameUrl(url) && !st.allowNative) {
        log("WS", "sink HSLO tab socket");
        return makeFakeSocket(url);
      }
      return protocols !== undefined ? new NativeWS(url, protocols) : new NativeWS(url);
    }
    Wrapped.prototype = NativeWS.prototype;
    Wrapped.CONNECTING = NativeWS.CONNECTING;
    Wrapped.OPEN = NativeWS.OPEN;
    Wrapped.CLOSING = NativeWS.CLOSING;
    Wrapped.CLOSED = NativeWS.CLOSED;
    Wrapped.__hsloSenpaHook = true;
    hookWebSocket.Wrapped = Wrapped;
    hookWebSocket.Native = NativeWS;
    if (global.WebSocket !== NativeWS) global.WebSocket = NativeWS;
    hookWebSocket.done = true;
    return true;
  }

  function withSink(fn) {
    hookWebSocket();
    var prev = global.WebSocket;
    if (hookWebSocket.Wrapped) global.WebSocket = hookWebSocket.Wrapped;
    try {
      return fn();
    } finally {
      global.WebSocket = prev === hookWebSocket.Wrapped ? NativeWS : prev;
    }
  }

  function workerUrl() {
    var base = global.__HSLO_BASE__ || "/";
    try {
      return new URL("ffa/hslo-ffa-codec-worker.js", base).href;
    } catch (_) {
      return "ffa/hslo-ffa-codec-worker.js";
    }
  }

  function b64ToBytes(b64) {
    var bin = atob(String(b64 || ""));
    var u8 = new Uint8Array(bin.length);
    for (var n = 0; n < bin.length; n++) u8[n] = bin.charCodeAt(n);
    return u8;
  }

  function wasmBytes() {
    if (global.__HSLO_WASM_BYTES__) return global.__HSLO_WASM_BYTES__;
    if (global.__HSLO_WASM_B64__) {
      global.__HSLO_WASM_BYTES__ = b64ToBytes(global.__HSLO_WASM_B64__);
      return global.__HSLO_WASM_BYTES__;
    }
    return null;
  }

  function onCodecOpen(gen) {
    if (gen !== st.gen) return;
    st.socketOpen = true;
    st.connecting = false;
    global.__HSLO_SENPA_CONNECTED__ = false;
    restoreWsHook();
    status("WS_OPEN — waiting opcode 8");
    log("WEBSOCKET OPEN", (st.server && st.server.host) || "");
    st.handshakeTimer = setTimeout(function () {
      if (gen !== st.gen || st.authOk) return;
      status("handshake timeout — no opcode 8", true);
      log("ERROR", "handshake timeout");
      killConnection();
      resetSession();
      scheduleReconnect("handshake timeout");
    }, HANDSHAKE_MS);
  }

  function onCodecClose(gen, ev) {
    if (gen !== st.gen) return;
    var code = ev && ev.code;
    restoreWsHook();
    var wasAuth = st.authOk;
    resetSession();
    log("DISCONNECT", "code=" + code + " reason=\"" + ((ev && ev.reason) || "") + "\"");
    if (st.suppressReconnect) {
      st.suppressReconnect = false;
      status("disconnected");
      return;
    }
    if (wasAuth && (code === 1000 || code === 1001)) {
      status("disconnected");
      return;
    }
    scheduleReconnect("codec closed code=" + code);
  }

  function startPageCodec(server, gen) {
    var codec = pageCodec();
    if (!codec || typeof codec.connect !== "function") return false;
    st.pageCodec = true;
    st.connecting = true;
    armNative();
    var url = wsUrl(server);
    log("CONNECT", url.replace(/([?&]tid=)[a-f0-9]+/i, "$1***").replace(/\?password=.*/, "?password="));
    status("CONNECTING " + server.label + " " + server.host);
    codec
      .connect(url, {
        onOpen: function () {
          onCodecOpen(gen);
        },
        onClose: function (ev) {
          onCodecClose(gen, ev);
        },
        onMessage: onMessage,
        onError: function (msg) {
          if (gen !== st.gen) return;
          status("WS_ERROR " + msg, true);
        }
      })
      .catch(function (err) {
        if (gen !== st.gen) return;
        restoreWsHook();
        status("CODEC_FAILED " + (err && err.message ? err.message : err), true);
        st.connecting = false;
        st.pageCodec = false;
        scheduleReconnect("codec failed");
      });
    return true;
  }

  function ensureWorker(server, gen) {
    if (st.worker) return st.worker;
    var src = global.__HSLO_WORKER_SRC__;
    var worker = src
      ? new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })))
      : new Worker(workerUrl());
    st.worker = worker;
    worker.onmessage = function (ev) {
      if (gen !== st.gen) return;
      var msg = ev.data || {};
      if (msg.type === "log") {
        log("WS", String(msg.msg || "").replace(/^\[WASM\]\s*/, ""));
        return;
      }
      if (msg.type === "codec-ready") {
        var workerConnectUrl = wsUrl(server);
        log("CONNECT", "worker url=" + workerConnectUrl.replace(/([?&]tid=)[a-f0-9]+/i, "$1***").replace(/\?password=.*/, "?password="));
        worker.postMessage({ type: "connect", url: workerConnectUrl });
        return;
      }
      if (msg.type === "open") {
        onCodecOpen(gen);
        return;
      }
      if (msg.type === "message") {
        onMessage(msg.data);
        return;
      }
      if (msg.type === "close") {
        onCodecClose(gen, msg);
        return;
      }
      if (msg.type === "error") {
        status((msg.code || "WS_ERROR") + " " + (msg.msg || ""), true);
      }
    };
    worker.onerror = function (err) {
      if (gen !== st.gen) return;
      status("codec worker error " + (err && err.message ? err.message : ""), true);
    };
    var bytes = wasmBytes();
    if (bytes) {
      var copy = bytes.slice().buffer;
      worker.postMessage({ type: "init", data: copy }, [copy]);
    } else if (global.__HSLO_WASM_BLOB__) {
      worker.postMessage({ type: "init", wasmUrl: global.__HSLO_WASM_BLOB__ });
    }
    return worker;
  }

  function connectSelected(reason) {
    var server = selectedServer();
    if (!server) {
      status("invalid server", true);
      log("ERROR", "connect without catalog server");
      return;
    }
    log("SERVER", server.label + " " + server.host + " mode=" + server.mode + " reason=" + (reason || "select"));
    persistSelection(server);
    var sameLive =
      st.server &&
      st.server.id === server.id &&
      (st.authOk || st.socketOpen || st.connecting) &&
      reason !== "reconnect" &&
      reason !== "select" &&
      reason !== "q.reconnect";
    if (sameLive) {
      if (reason === "play" && st.authOk && st.wantSpawn1) sendSpawn(1);
      return;
    }
    killConnection();
    resetSession();
    clearCells();
    st.server = server;
    var gen = ++st.gen;
    setTimeout(function () {
      if (gen !== st.gen) return;
      st.suppressReconnect = false;
      if (startPageCodec(server, gen)) return;
      st.connecting = true;
      status("CONNECTING worker codec " + server.host);
      ensureWorker(server, gen);
    }, 80);
  }

  function injectOptions() {
    var sel = regionsEl();
    if (!sel) return false;
    var existing = {};
    var i;
    for (i = sel.options.length - 1; i >= 0; i--) {
      var opt = sel.options[i];
      var id = opt.getAttribute("data-hslo-id") || opt.getAttribute("data-onyx-id");
      var val = String(opt.value || "");
      if (id === "ffa-eu" || /EU FFA - SENPA\.IO/i.test(opt.textContent || "")) {
        sel.remove(i);
        continue;
      }
      if (id && catalog.byId(id)) existing[id] = opt;
    }
    var saved = restoreSelectionId();
    var first = null;
    var insertAt = 0;
    for (i = 0; i < catalog.list.length; i++) {
      var srv = catalog.list[i];
      var node = existing[srv.id];
      if (!node) {
        node = document.createElement("option");
        if (sel.options.length > insertAt) sel.add(node, sel.options[insertAt]);
        else sel.appendChild(node);
      } else if (sel.options[insertAt] !== node) {
        sel.removeChild(node);
        if (sel.options.length > insertAt) sel.add(node, sel.options[insertAt]);
        else sel.appendChild(node);
      }
      insertAt++;
      node.value = "wss://" + srv.host;
      node.textContent = srv.label;
      node.setAttribute("data-hslo-id", srv.id);
      node.setAttribute("data-hslo-mode", srv.mode);
      node.setAttribute("data-hslo-host", srv.host);
      if (!first) first = node;
      if (saved === srv.id) first = node;
    }
    if (first && !sel.__hsloSenpaRestored) {
      sel.__hsloSenpaRestored = true;
      first.selected = true;
    }
    if (sel.selectedIndex < 0 && sel.options.length) sel.selectedIndex = 0;
    ensureSenpaRegion();
    syncRegionStore();
    return true;
  }

  function hookWsurl() {
    var q = global.q;
    if (!q || typeof q.wsurl !== "function" || q.__hsloSenpaWsurl) return !!q && !!q.__hsloSenpaWsurl;
    var orig = q.wsurl.bind(q);
    q.wsurl = function (e) {
      var server = selectedServer();
      var raw = String(e || "");
      if (server && (catalog.isCatalogHost(raw) || isSenpaSelected())) return wsUrl(server);
      return orig(e);
    };
    q.__hsloSenpaWsurl = true;
    return true;
  }

  function hookInit() {
    var q = global.q;
    if (!q || typeof q.init !== "function" || q.__hsloSenpaInit) return !!q && !!q.__hsloSenpaInit;
    var orig = q.init.bind(q);
    q.init = function (e) {
      var server = selectedServer();
      var ret = withSink(function () {
        return orig(e);
      });
      if (server) {
        var live = st.authOk && st.server && st.server.id === server.id;
        if (!live) connectSelected("q.init");
      }
      return ret;
    };
    q.__hsloSenpaInit = true;
    return true;
  }

  function hookReconnect() {
    var q = global.q;
    if (!q || typeof q.reconnect !== "function" || q.__hsloSenpaReconnect) {
      return !!q && !!q.__hsloSenpaReconnect;
    }
    var orig = q.reconnect.bind(q);
    q.reconnect = function (tab) {
      if (isSenpaSelected()) {
        st.reconnectLeft = RECONNECT_TRIES;
        st.reconnectMs = RECONNECT_BASE_MS;
        connectSelected("q.reconnect:" + tab);
        return;
      }
      return withSink(function () {
        return orig(tab);
      });
    };
    q.__hsloSenpaReconnect = true;
    return true;
  }

  function muteCommanderPing() {
    var P = global.re;
    if (!P || !P.commanderPoints || P.commanderPoints.__hsloSenpaMute) return;
    var set = P.commanderPoints;
    var orig = set.add.bind(set);
    set.__hsloSenpaMute = true;
    set.add = function (value) {
      if (isSenpaSelected()) return this;
      return orig(value);
    };
  }

  function hookHotkeyStore() {
    var store = global.c;
    if (!store || store.__hsloHkHook || typeof store.set !== "function") return;
    store.__hsloHkHook = true;
    var orig = store.set.bind(store);
    store.set = function (group, name, value) {
      if (group === "hotkeys" && name) st.hotkeysLive[name] = value;
      return orig(group, name, value);
    };
  }

  function closeInputsPanel() {
    var el = document.getElementById("inputs");
    if (el) el.style.display = "none";
    try {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    } catch (_) {}
  }

  function uiCapturesKeys() {
    try {
      if (global.z && global.z.isOpened) return true;
    } catch (_) {}
    var ae = document.activeElement;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return true;
    if (ae && ae.classList && ae.classList.contains("key")) return true;
    return false;
  }

  function hsloHotkey(name, fallback) {
    try {
      var row = document.querySelector('#hotkeys .row[name="' + name + '"] input.key, #hotkeys .row[name="' + name + '"] .key');
      if (row) {
        var shown = String(row.value || "").trim().toUpperCase();
        if (shown && shown !== "NONE") return shown;
      }
    } catch (_) {}
    if (st.hotkeysLive && st.hotkeysLive[name]) return String(st.hotkeysLive[name]).toUpperCase();
    try {
      var store = global.c;
      if (store && typeof store.get === "function") {
        var v = store.get("hotkeys", name);
        if (v && v !== true) return String(v).toUpperCase();
      }
    } catch (_) {}
    return String(fallback || "").toUpperCase();
  }

  function hsloKeyFromEvent(ev) {
    var t = ev.keyCode || ev.which;
    var s = ev.ctrlKey ? "CTRL+" : ev.altKey ? "ALT+" : "";
    var i = "";
    if (t > 64 && t < 91) i = String.fromCharCode(t);
    else if (t > 47 && t < 58) i = String(t - 48);
    else if (!s) {
      if (t === 13) i = "ENTER";
      else if (t === 27) i = "ESC";
      else if (t === 32) i = "SPACE";
      else if (t === 16) i = "SHIFT";
      else if (t === 9) i = "TAB";
      else if (t === 46) i = "DEL";
      else if (t === 38) i = "UP";
      else if (t === 40) i = "DOWN";
      else if (t === 37) i = "LEFT";
      else if (t === 39) i = "RIGHT";
      else if (t === 192) i = "TILDE";
    }
    return i ? (s ? s + i : i) : "";
  }

  function onGameKey(ev) {
    if (!st.authOk || !isSenpaSelected()) return;
    if (uiCapturesKeys()) return;
    var t = ev.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (t && t.classList && t.classList.contains("key")) return;
    var key = hsloKeyFromEvent(ev);
    if (!key) return;
    var splitKey = hsloHotkey("splitKey", "SPACE");
    var feedKey = hsloHotkey("feedKey", "W");
    var macroKey = hsloHotkey("macroFeedKey", "Q");
    var tabKey = hsloHotkey("multiboxTab", "TAB");
    var doubleKey = hsloHotkey("doubleSplitKey", "E");
    var split16Key = hsloHotkey("split16Key", "R");
    if (key === splitKey) {
      sendSplit(st.controllingTab);
    } else if (key === doubleKey) {
      if (ev.repeat) return;
      splitBurst(2);
    } else if (key === split16Key) {
      if (ev.repeat) return;
      splitBurst(4);
    } else if (key === macroKey) {
      if (ev.repeat) return;
      startMacroFeed();
    } else if (key === feedKey) {
      sendFeed();
    } else if (key === tabKey && dualMode()) {
      ev.preventDefault();
      if (st.controllingTab === 1) {
        st.controllingTab = 2;
        syncHudTab();
        log("GAME", "controllingTab=2 cells=" + ownCellCount(2));
        if (!tabAlive(2)) spawnTabWithRetry(2);
      } else {
        st.controllingTab = 1;
        syncHudTab();
        log("GAME", "controllingTab=1 cells=" + ownCellCount(1));
        if (!tabAlive(1)) spawnTabWithRetry(1);
      }
      status(
        "TAB " +
          st.controllingTab +
          (!tabAlive(st.controllingTab) ? " — spawning tab " + st.controllingTab : "")
      );
    }
  }

  function bindMenu() {
    var sel = regionsEl();
    if (sel && !sel.__hsloSenpaBound) {
      sel.__hsloSenpaBound = true;
      sel.addEventListener("change", function () {
        var server = selectedServer();
        if (server) {
          persistSelection(server);
          connectSelected("select");
        } else {
          disconnect("switched to non-senpa");
        }
      });
    }
    if (!document.__hsloSenpaPlayBound) {
      document.__hsloSenpaPlayBound = true;
      document.addEventListener(
        "click",
        function (ev) {
          var play = ev.target && ev.target.closest && ev.target.closest("#button-play");
          var spec = ev.target && ev.target.closest && ev.target.closest("#button-spectate");
          if (!play && !spec) return;
          if (!isSenpaSelected()) return;
          st.play = !!play;
          st.spectate = !!spec;
          if (play) st.wantSpawn1 = true;
          if (play || spec) closeInputsPanel();
          if (spec) {
            st.wantSpawn1 = false;
            var topBtn = document.getElementById("spectate-mode-top");
            var mouseBtn = document.getElementById("spectate-mode-mouse");
            if (topBtn) topBtn.classList.remove("active");
            if (mouseBtn) mouseBtn.classList.add("active");
            wrapRenderer();
            captureCamFromRenderer();
            applySpecCamera(st.specAgarX, st.specAgarY, true);
          }
          var live = st.authOk && st.server && selectedServer() && st.server.id === selectedServer().id;
          if (live) {
            if (play) spawnTabWithRetry(1);
          } else {
            connectSelected(play ? "play" : "spectate");
          }
          if (play && !live) spawnTabWithRetry(1);
        },
        true
      );
    }
    if (!document.__hsloSenpaMouse) {
      document.__hsloSenpaMouse = true;
      document.addEventListener(
        "mousemove",
        function (e) {
          if (!st.authOk || !st.border) return;
          st.lastCx = e.clientX;
          st.lastCy = e.clientY;
          var agar = screenToAgar(e.clientX, e.clientY);
          var sen = agarToSenpa(agar.x, agar.y);
          st.mouseX = sen.x;
          st.mouseY = sen.y;
        },
        true
      );
    }
    if (!document.__hsloSenpaKeyRecord) {
      document.__hsloSenpaKeyRecord = true;
      document.addEventListener(
        "keydown",
        function (ev) {
          var t = ev.target;
          if (!t || !t.classList || !t.classList.contains("key")) return;
          var row = t.closest && t.closest("#hotkeys .row");
          if (!row) return;
          setTimeout(function () {
            var name = row.getAttribute("name");
            if (name) st.hotkeysLive[name] = String(t.value || "").trim().toUpperCase();
          }, 0);
        },
        true
      );
    }
    if (!document.__hsloSenpaKeys) {
      document.__hsloSenpaKeys = true;
      document.addEventListener("keydown", onGameKey, false);
      document.addEventListener(
        "keyup",
        function (ev) {
          if (!isSenpaSelected()) return;
          var key = hsloKeyFromEvent(ev);
          if (!key) return;
          if (key === hsloHotkey("macroFeedKey", "Q")) stopMacroFeed();
        },
        false
      );
      global.addEventListener("blur", stopMacroFeed);
    }
  }

  function watchRegions() {
    var sel = regionsEl();
    if (!sel || sel.__hsloSenpaObs) return;
    sel.__hsloSenpaObs = true;
    new MutationObserver(function () {
      injectOptions();
    }).observe(sel, { childList: true });
  }

  function hookJqVal() {
    var jq = global.jQuery || global.$;
    if (!jq || !jq.fn || typeof jq.fn.val !== "function" || jq.fn.val.__hsloSenpa) return;
    var orig = jq.fn.val;
    jq.fn.val = function () {
      var ret = orig.apply(this, arguments);
      if (arguments.length === 0 && this && this.length && this[0] && this[0].id === "regions") {
        if (ret == null || ret === "") {
          var sel = this[0];
          if (sel.options && sel.options.length) {
            if (sel.selectedIndex < 0) sel.selectedIndex = 0;
            ret = orig.apply(this, arguments);
          }
          if (ret == null || ret === "") ret = "wss://eu.senpa.io:2001";
        }
      }
      return ret;
    };
    jq.fn.val.__hsloSenpa = true;
  }

  function hookGetServer() {
    if (st._getServerHooked) return;
    function wrap(o) {
      if (!o || typeof o.getServer !== "function" || o.__hsloGetServer) return false;
      var src = "";
      try {
        src = Function.prototype.toString.call(o.getServer);
      } catch (_) {}
      if (src.indexOf("indexOf") < 0 && typeof o.findServer !== "function" && !o.master_url) return false;
      o.__hsloGetServer = true;
      var orig = o.getServer.bind(o);
      o.getServer = function (e, t) {
        if (e == null || e === "") {
          ensureSenpaRegion();
          var sel = regionsEl();
          e = (sel && sel.value) || "wss://eu.senpa.io:2001";
        }
        e = String(e);
        if (e.indexOf("ws") < 0 && (catalog.isCatalogHost(e) || e.indexOf("senpa") >= 0)) e = "wss://" + e.replace(/^\/\//, "");
        try {
          return orig(e, t);
        } catch (err) {
          log("ERROR", "getServer " + (err && err.message ? err.message : err));
          var host = e.replace(/^wss?:\/\//, "");
          return { endpoints: { https: host, http: host } };
        }
      };
      st._getServerHooked = true;
      log("GAME", "hooked getServer");
      return true;
    }
    function wrapParty(o) {
      if (!o || typeof o.createParty !== "function" || o.__hsloParty) return false;
      o.__hsloParty = true;
      var orig = o.createParty.bind(o);
      o.createParty = function () {
        injectOptions();
        ensureSenpaRegion();
        try {
          return orig();
        } catch (err) {
          log("ERROR", "createParty " + (err && err.message ? err.message : err));
        }
      };
      return true;
    }
    var names = Object.getOwnPropertyNames(global);
    for (var i = 0; i < names.length; i++) {
      try {
        wrap(global[names[i]]);
        wrapParty(global[names[i]]);
      } catch (_) {}
    }
  }

  function bootTick() {
    hookWebSocket();
    injectOptions();
    watchRegions();
    hookWsurl();
    hookInit();
    hookReconnect();
    bindMenu();
    wrapRenderer();
    muteCommanderPing();
    patchNoSkinPlaceholder();
    ensurePeerMapCanvas();
    hookHotkeyStore();
    hookJqVal();
    hookGetServer();
    ensureSenpaRegion();
    syncRegionStore();
    return !!(regionsEl() && global.q && global.q.__hsloSenpaWsurl);
  }

  hookWebSocket();

  global.__HSLO_SENPA__ = {
    servers: catalog.list,
    selected: selectedServer,
    connect: function () {
      connectSelected("api");
    },
    disconnect: function () {
      disconnect("api");
    },
    state: function () {
      return {
        server: st.server,
        socketOpen: st.socketOpen,
        authOk: st.authOk,
        spawned: st.spawned,
        status: st.lastStatus
      };
    }
  };

  var readyLogged = false;
  setInterval(function () {
    var ok = bootTick();
    if (ok && !readyLogged) {
      readyLogged = true;
      log("GAME", "ready Dual/FFA codec=" + !!(pageCodec() || global.__HSLO_WORKER_SRC__ || global.__HSLO_WASM_B64__));
    }
  }, 200);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootTick);
  } else {
    bootTick();
  }
})(typeof window !== "undefined" ? window : globalThis);
