/**
 * HSLO Senpa server catalog.
 * FFA follows the current ONYX endpoint and URL shape (eu1.senpa.io:7101?po=&tid=).
 */
(function (global) {
  "use strict";

  var SERVERS = [
    {
      id: "ffa-europe",
      label: "FFA Europe",
      host: "eu1.senpa.io:7101",
      mode: "ffa"
    },
    {
      id: "eu-dual",
      label: "EU Dual",
      host: "eu.senpa.io:2001",
      mode: "dual"
    }
  ];

  var BY_ID = Object.create(null);
  var HOSTS = Object.create(null);
  for (var i = 0; i < SERVERS.length; i++) {
    BY_ID[SERVERS[i].id] = SERVERS[i];
    HOSTS[SERVERS[i].host] = true;
  }

  function byId(id) {
    return BY_ID[String(id || "")] || null;
  }

  function fromOption(opt) {
    if (!opt) return null;
    var id = opt.getAttribute && opt.getAttribute("data-hslo-id");
    if (id && BY_ID[id]) return BY_ID[id];
    var mode = opt.getAttribute && opt.getAttribute("data-hslo-mode");
    var host = String((opt.getAttribute && opt.getAttribute("data-hslo-host")) || opt.value || "").replace(/^wss:\/\//, "");
    for (var n = 0; n < SERVERS.length; n++) {
      if (SERVERS[n].host === host && (!mode || SERVERS[n].mode === mode)) return SERVERS[n];
    }
    return BY_ID[host] || null;
  }

  function isCatalogHost(host) {
    return !!HOSTS[String(host || "")];
  }

  function isAllowedWsUrl(url) {
    var raw = String(url || "");
    return raw.indexOf("wss://eu1.senpa.io:7101") === 0 || raw.indexOf("wss://eu.senpa.io:2001") === 0;
  }

  global.HSLOSenpaServers = {
    list: SERVERS,
    byId: byId,
    fromOption: fromOption,
    isCatalogHost: isCatalogHost,
    isAllowedWsUrl: isAllowedWsUrl,
    storageKey: "hslo:selected-server"
  };
})(typeof window !== "undefined" ? window : globalThis);
