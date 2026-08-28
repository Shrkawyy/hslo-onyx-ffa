/**
 * Official Senpa account login for HSLO (Discord / Facebook / Google).
 * Popup goes to api.senpa.io/auth/<provider>; the JWT is picked up from the
 * postMessage reply or from senpa.io localStorage, then reused for FFA opcode 13.
 */
(function (global) {
  "use strict";

  var AUTH_ORIGIN = "https://api.senpa.io";
  var SESSION_KEY = "senpaio:session";
  var TOKEN_KEY = "senpa_auth_token";
  var PROFILE_KEY = "hslo:senpa-profile";

  var PROVIDERS = {
    discord: { label: "Discord", path: "/auth/discord" },
    facebook: { label: "Facebook", path: "/auth/facebook" },
    google: { label: "Google", path: "/auth/google" }
  };

  var pollTimer = null;
  var popupRef = null;

  function log(msg) {
    console.log("[HSLO-AUTH] " + msg);
  }

  function normalize(raw) {
    return String(raw || "").trim().replace(/^["']|["']$/g, "");
  }

  function decodePayload(token) {
    var parts = String(token || "").split(".");
    if (parts.length < 3) return null;
    try {
      var b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4) b64 += "=";
      return JSON.parse(atob(b64));
    } catch (_) {
      return null;
    }
  }

  function isAlive(token) {
    var payload = decodePayload(token);
    if (!payload) return false;
    if (payload.exp && payload.exp * 1000 <= Date.now()) return false;
    return true;
  }

  function readAccountBlob() {
    try {
      var raw = localStorage.getItem("senpaio:account");
      if (!raw) return "";
      var text = raw;
      try {
        var bin = atob(raw);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        if (bytes.length >= 2 && bytes[1] === 0) {
          text = new TextDecoder("utf-16le").decode(bytes);
        }
      } catch (_) {}
      var data = JSON.parse(text);
      return (data && data.auth) || "";
    } catch (_) {
      return "";
    }
  }

  function scanStorage() {
    var keys = [SESSION_KEY, TOKEN_KEY, "authToken", "token"];
    for (var i = 0; i < keys.length; i++) {
      try {
        var v = normalize(localStorage.getItem(keys[i]));
        if (v && isAlive(v)) return v;
      } catch (_) {}
    }
    try {
      var s = normalize(sessionStorage.getItem("authToken"));
      if (s && isAlive(s)) return s;
    } catch (_) {}
    var blob = normalize(readAccountBlob());
    if (blob && isAlive(blob)) return blob;
    return "";
  }

  function getToken() {
    return scanStorage();
  }

  function displayName(payload) {
    if (!payload) return "";
    return (
      payload.username ||
      payload.nickname ||
      payload.name ||
      payload.global_name ||
      payload.email ||
      ""
    );
  }

  function getProfile() {
    try {
      return JSON.parse(localStorage.getItem(PROFILE_KEY) || "null");
    } catch (_) {
      return null;
    }
  }

  function store(token, provider) {
    token = normalize(token);
    if (!token || token.split(".").length < 3) throw new Error("Not a Senpa JWT");
    if (!isAlive(token)) throw new Error("Senpa session expired — login again");
    try {
      localStorage.setItem(SESSION_KEY, token);
      localStorage.setItem(TOKEN_KEY, token);
    } catch (_) {}
    var payload = decodePayload(token) || {};
    var profile = {
      name: displayName(payload) || "Senpa Player",
      provider: provider || payload.provider || "senpa",
      exp: payload.exp || 0
    };
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    } catch (_) {}
    log("logged in as " + profile.name + " (" + profile.provider + ")");
    global.dispatchEvent(new CustomEvent("hslo:senpa-auth", { detail: { token: token, profile: profile } }));
    refreshUi();
    return profile;
  }

  function logout() {
    try {
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(PROFILE_KEY);
    } catch (_) {}
    log("logged out");
    global.dispatchEvent(new CustomEvent("hslo:senpa-auth", { detail: { token: "", profile: null } }));
    refreshUi();
  }

  function stopPoll() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function startPoll(provider) {
    stopPoll();
    var before = getToken();
    var tries = 0;
    pollTimer = setInterval(function () {
      tries++;
      var now = getToken();
      if (now && now !== before) {
        stopPoll();
        try {
          store(now, provider);
        } catch (err) {
          log("login failed: " + (err && err.message));
        }
        try {
          if (popupRef && !popupRef.closed) popupRef.close();
        } catch (_) {}
        return;
      }
      var closed = false;
      try {
        closed = !!(popupRef && popupRef.closed);
      } catch (_) {}
      if (tries > 300 || (closed && tries > 8 && !now)) {
        stopPoll();
        if (!now) log("login window closed without a Senpa session");
      }
    }, 500);
  }

  function openLogin(name) {
    var provider = PROVIDERS[String(name || "discord").toLowerCase()];
    if (!provider) provider = PROVIDERS.discord;
    var url = AUTH_ORIGIN + provider.path;
    popupRef = global.open(
      url,
      "Senpa " + provider.label + " Login",
      "toolbar=no,menubar=no,width=600,height=760,top=80,left=120"
    );
    if (!popupRef) {
      log("popup blocked — allow popups for senpa.io");
      return null;
    }
    try {
      popupRef.focus();
    } catch (_) {}
    log("waiting for Senpa " + provider.label + " login…");
    startPoll(provider.label.toLowerCase());
    return popupRef;
  }

  global.addEventListener("message", function (event) {
    if (event.origin !== AUTH_ORIGIN && event.origin !== location.origin) return;
    var data = event.data || {};
    if (data.type === "senpa-auth-ready") {
      try {
        if (event.source) event.source.postMessage({ type: "senpa-auth-hello" }, event.origin);
      } catch (_) {}
      return;
    }
    var token = data.access_token || data.token || data.jwt;
    if (!token) return;
    try {
      store(token, data.provider || "");
      stopPoll();
      try {
        if (popupRef && !popupRef.closed) popupRef.close();
      } catch (_) {}
    } catch (err) {
      log("login failed: " + (err && err.message));
    }
  });

  function styleButton(el, active, title) {
    if (!el) return;
    el.style.cursor = "pointer";
    el.title = title;
    el.style.color = active ? "#3ddc84" : "";
  }

  function refreshUi() {
    var token = getToken();
    var profile = getProfile();
    var who = token ? (profile && profile.name) || "Senpa" : "";
    var via = token && profile && profile.provider ? " (" + profile.provider + ")" : "";
    styleButton(
      document.getElementById("senpa-discord-login"),
      token && profile && profile.provider === "discord",
      token ? "Senpa: " + who + via : "Login me Discord (senpa.io)"
    );
    styleButton(
      document.getElementById("login-facebook"),
      token && profile && profile.provider === "facebook",
      token ? "Senpa: " + who + via : "Login me Facebook (senpa.io)"
    );
    styleButton(
      document.getElementById("login-google"),
      token && profile && profile.provider === "google",
      token ? "Senpa: " + who + via : "Login me Google (senpa.io)"
    );
    var ip = document.getElementById("ip-box");
    if (ip && token) ip.setAttribute("data-senpa-user", who);
  }

  function bindButton(id, provider) {
    var el = document.getElementById(id);
    if (!el || el.__hsloAuthBound) return;
    el.__hsloAuthBound = true;
    el.removeAttribute("onclick");
    el.addEventListener(
      "click",
      function (ev) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        openLogin(provider);
      },
      true
    );
  }

  function bindLogout() {
    var el = document.getElementById("logout");
    if (!el || el.__hsloAuthBound) return;
    el.__hsloAuthBound = true;
    el.addEventListener(
      "click",
      function () {
        logout();
      },
      true
    );
  }

  function bindAll() {
    bindButton("senpa-discord-login", "discord");
    bindButton("login-facebook", "facebook");
    bindButton("login-google", "google");
    bindLogout();
    refreshUi();
  }

  global.HSLOAuth = {
    getToken: getToken,
    getProfile: getProfile,
    isAuthenticated: function () {
      return !!getToken();
    },
    login: openLogin,
    setToken: store,
    logout: logout,
    providers: Object.keys(PROVIDERS)
  };

  setInterval(bindAll, 500);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindAll);
  } else {
    bindAll();
  }

  if (getToken()) log("Senpa session found — FFA will authenticate with it");
  else log("no Senpa session — click Discord or Facebook in the menu bar to login");
})(typeof window !== "undefined" ? window : globalThis);
