var API_BASE = "/api";

document.addEventListener("DOMContentLoaded", function () {
  var loginBtn = document.getElementById("loginBtn");
  var backdrop = document.getElementById("loginModalBackdrop");
  var closeBtn = document.getElementById("loginModalClose");

  function openModal() { backdrop.classList.add("open"); }
  function closeModal() { backdrop.classList.remove("open"); }

  if (loginBtn) loginBtn.addEventListener("click", function () {
    // Already signed in: jump straight to the portal instead of re-asking.
    if (getClientToken()) { showPortal(); return; }
    openModal();
  });
  if (closeBtn) closeBtn.addEventListener("click", closeModal);
  if (backdrop) {
    backdrop.addEventListener("click", function (e) {
      if (e.target === backdrop) closeModal();
    });
  }
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeModal();
  });

  // ------------------------------------------------------------------
  // Client portal: podcast episodes + articles
  // Backed by the relay server's /api/login and /api/podcast/* routes.
  // ------------------------------------------------------------------
  var CLIENT_TOKEN_KEY = "shm_client_token";

  var loginForm = document.getElementById("loginForm");
  var loginPassword = document.getElementById("loginPassword");
  var loginError = document.getElementById("loginError");
  var loginSubmit = document.getElementById("loginSubmit");
  var portal = document.getElementById("portal");
  var portalLogout = document.getElementById("portalLogout");

  function getClientToken() { return sessionStorage.getItem(CLIENT_TOKEN_KEY) || ""; }
  function setClientToken(t) { sessionStorage.setItem(CLIENT_TOKEN_KEY, t); }
  function clearClientToken() { sessionStorage.removeItem(CLIENT_TOKEN_KEY); }

  function showPortal() {
    if (!portal) return;
    portal.hidden = false;
    if (loginBtn) loginBtn.textContent = "Client Portal";
    loadEpisodes();
    loadArticles();
    portal.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function hidePortal() {
    if (!portal) return;
    portal.hidden = true;
    if (loginBtn) loginBtn.textContent = "Client Login";
  }

  // Any 401 from a portal call means the server-side session is gone
  // (expired, or the relay restarted — sessions are in memory).
  function handleAuthLoss() {
    clearClientToken();
    hidePortal();
    if (loginError) {
      loginError.textContent = "Your session expired. Please sign in again.";
      loginError.hidden = false;
    }
    openModal();
  }

  function clientFetch(path, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    opts.headers["X-Client-Token"] = getClientToken();
    return fetch(API_BASE + path, opts).then(function (res) {
      if (res.status === 401) { handleAuthLoss(); throw new Error("not signed in"); }
      return res.json().then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
    });
  }

  if (loginForm) {
    loginForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var password = loginPassword.value;
      if (!password) return;
      loginError.hidden = true;
      loginSubmit.disabled = true;
      loginSubmit.textContent = "Signing in…";

      fetch(API_BASE + "/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: password })
      })
        .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, data: d }; }); })
        .then(function (result) {
          if (!result.ok || !result.data.token) {
            loginError.textContent = (result.data && result.data.error) || "Incorrect password.";
            loginError.hidden = false;
            return;
          }
          setClientToken(result.data.token);
          loginPassword.value = "";
          closeModal();
          showPortal();
        })
        .catch(function () {
          loginError.textContent = "Could not reach the server. Try again.";
          loginError.hidden = false;
        })
        .finally(function () {
          loginSubmit.disabled = false;
          loginSubmit.textContent = "Sign in";
        });
    });
  }

  if (portalLogout) {
    portalLogout.addEventListener("click", function () {
      clientFetch("/logout", { method: "POST" }).catch(function () {});
      clearClientToken();
      hidePortal();
    });
  }

  // --- portal tabs ---
  var tabs = document.querySelectorAll(".portal-tab");
  Array.prototype.forEach.call(tabs, function (tab) {
    tab.addEventListener("click", function () {
      var name = tab.getAttribute("data-tab");
      Array.prototype.forEach.call(tabs, function (t) {
        var active = t === tab;
        t.classList.toggle("is-active", active);
        t.setAttribute("aria-selected", active ? "true" : "false");
      });
      Array.prototype.forEach.call(document.querySelectorAll(".portal-pane"), function (pane) {
        pane.hidden = pane.getAttribute("data-pane") !== name;
      });
    });
  });

  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function formatDate(value) {
    if (!value) return "";
    var d = new Date(value.replace(" ", "T") + "Z");
    return isNaN(d.getTime()) ? value : d.toLocaleDateString();
  }

  function setMsg(el, text, isError) {
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("is-error", !!isError);
  }

  // Upload via XHR so large podcast audio gets a real progress bar.
  function uploadForm(path, formData, progressEl, barEl) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open("POST", API_BASE + path);
      xhr.setRequestHeader("X-Client-Token", getClientToken());
      if (progressEl && barEl) {
        progressEl.hidden = false;
        barEl.style.width = "0%";
        xhr.upload.addEventListener("progress", function (e) {
          if (e.lengthComputable) barEl.style.width = Math.round((e.loaded / e.total) * 100) + "%";
        });
      }
      xhr.addEventListener("load", function () {
        if (progressEl) progressEl.hidden = true;
        if (xhr.status === 401) { handleAuthLoss(); reject(new Error("not signed in")); return; }
        var data = {};
        try { data = JSON.parse(xhr.responseText); } catch (err) { /* non-JSON error page */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data.error || ("upload failed (" + xhr.status + ")")));
      });
      xhr.addEventListener("error", function () {
        if (progressEl) progressEl.hidden = true;
        reject(new Error("network error"));
      });
      xhr.send(formData);
    });
  }

  // --- episodes ---
  var episodeForm = document.getElementById("episodeForm");
  var episodeList = document.getElementById("episodeList");
  var epMsg = document.getElementById("epMsg");
  var epSubmit = document.getElementById("epSubmit");
  var epProgress = document.getElementById("epProgress");
  var epProgressBar = document.getElementById("epProgressBar");

  function loadEpisodes() {
    if (!episodeList) return;
    fetch(API_BASE + "/podcast/episodes")
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var rows = (data && data.episodes) || [];
        if (!rows.length) { episodeList.innerHTML = '<p class="fine-print">No episodes published yet.</p>'; return; }
        episodeList.innerHTML = rows.map(function (ep) {
          return '<div class="portal-item">' +
            (ep.cover_url ? '<img class="portal-thumb" src="' + ep.cover_url + '" alt="">' : '') +
            '<div class="portal-item-body">' +
              '<h4>' + escapeHtml(ep.title) + '</h4>' +
              '<p class="fine-print">' + formatDate(ep.published_at) + '</p>' +
              (ep.description ? '<p>' + escapeHtml(ep.description) + '</p>' : '') +
              '<audio controls preload="none" src="' + ep.audio_url + '"></audio>' +
            '</div>' +
            '<button class="btn btn-ghost btn-small" data-delete="episode" data-id="' + ep.id + '" type="button">Delete</button>' +
          '</div>';
        }).join("");
      })
      .catch(function () { episodeList.innerHTML = '<p class="media-error">Could not load episodes.</p>'; });
  }

  if (episodeForm) {
    episodeForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var title = document.getElementById("epTitle").value.trim();
      var audio = document.getElementById("epAudio").files[0];
      var cover = document.getElementById("epCover").files[0];
      if (!title || !audio) { setMsg(epMsg, "Title and an audio file are required.", true); return; }

      var fd = new FormData();
      fd.append("title", title);
      fd.append("description", document.getElementById("epDesc").value);
      fd.append("audio", audio);
      if (cover) fd.append("cover", cover);

      epSubmit.disabled = true;
      setMsg(epMsg, "Uploading…");
      uploadForm("/podcast/episodes", fd, epProgress, epProgressBar)
        .then(function () {
          setMsg(epMsg, "Episode published.");
          episodeForm.reset();
          loadEpisodes();
        })
        .catch(function (err) { setMsg(epMsg, err.message, true); })
        .finally(function () { epSubmit.disabled = false; });
    });
  }

  // --- articles ---
  var articleForm = document.getElementById("articleForm");
  var articleList = document.getElementById("articleList");
  var arMsg = document.getElementById("arMsg");
  var arSubmit = document.getElementById("arSubmit");
  var arProgress = document.getElementById("arProgress");
  var arProgressBar = document.getElementById("arProgressBar");

  function loadArticles() {
    if (!articleList) return;
    fetch(API_BASE + "/podcast/articles")
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var rows = (data && data.articles) || [];
        if (!rows.length) { articleList.innerHTML = '<p class="fine-print">No articles published yet.</p>'; return; }
        articleList.innerHTML = rows.map(function (ar) {
          return '<div class="portal-item">' +
            (ar.cover_url ? '<img class="portal-thumb" src="' + ar.cover_url + '" alt="">' : '') +
            '<div class="portal-item-body">' +
              '<h4>' + escapeHtml(ar.title) + '</h4>' +
              '<p class="fine-print">' + formatDate(ar.published_at) + '</p>' +
              '<p>' + escapeHtml(ar.body).replace(/\n/g, "<br>") + '</p>' +
            '</div>' +
            '<button class="btn btn-ghost btn-small" data-delete="article" data-id="' + ar.id + '" type="button">Delete</button>' +
          '</div>';
        }).join("");
      })
      .catch(function () { articleList.innerHTML = '<p class="media-error">Could not load articles.</p>'; });
  }

  if (articleForm) {
    articleForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var title = document.getElementById("arTitle").value.trim();
      var body = document.getElementById("arBody").value.trim();
      var cover = document.getElementById("arCover").files[0];
      if (!title || !body) { setMsg(arMsg, "Title and body are required.", true); return; }

      var fd = new FormData();
      fd.append("title", title);
      fd.append("body", body);
      if (cover) fd.append("cover", cover);

      arSubmit.disabled = true;
      setMsg(arMsg, "Publishing…");
      uploadForm("/podcast/articles", fd, arProgress, arProgressBar)
        .then(function () {
          setMsg(arMsg, "Article published.");
          articleForm.reset();
          loadArticles();
        })
        .catch(function (err) { setMsg(arMsg, err.message, true); })
        .finally(function () { arSubmit.disabled = false; });
    });
  }

  // --- deletes (event-delegated across both lists) ---
  if (portal) {
    portal.addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-delete]");
      if (!btn) return;
      var kind = btn.getAttribute("data-delete");
      var id = btn.getAttribute("data-id");
      var path = kind === "episode" ? "/podcast/episodes/" : "/podcast/articles/";
      btn.disabled = true;
      btn.textContent = "Deleting…";
      clientFetch(path + encodeURIComponent(id), { method: "DELETE" })
        .then(function () { kind === "episode" ? loadEpisodes() : loadArticles(); })
        .catch(function () { btn.disabled = false; btn.textContent = "Delete"; });
    });
  }

  // Restore the portal if this browser session is already signed in.
  if (getClientToken()) showPortal();

  // ------------------------------------------------------------------
  // Public podcast player
  // Reads the same public /api/podcast/* routes the portal writes to.
  // ------------------------------------------------------------------
  var audio = document.getElementById("playerAudio");
  var playerEl = document.getElementById("player");
  var publicEpisodeList = document.getElementById("publicEpisodeList");
  var publicArticleList = document.getElementById("publicArticleList");

  var SPEEDS = [1, 1.25, 1.5, 1.75, 2, 0.75];
  var speedIndex = 0;
  var episodes = [];
  var currentId = null;

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) return "0:00";
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s2 = Math.floor(sec % 60);
    var mm = h ? (m < 10 ? "0" + m : m) : m;
    return (h ? h + ":" : "") + mm + ":" + (s2 < 10 ? "0" + s2 : s2);
  }

  // Rows carry absolute Supabase Storage URLs; older rows may be missing one.
  function mediaUrl(url) { return url || ""; }

  function renderPublicEpisodes() {
    if (!publicEpisodeList) return;
    if (!episodes.length) {
      publicEpisodeList.innerHTML = '<p class="fine-print">No episodes published yet.</p>';
      return;
    }
    publicEpisodeList.innerHTML = episodes.map(function (ep, i) {
      return '<article class="episode-card' + (ep.id === currentId ? " is-playing" : "") + '" data-episode-id="' + ep.id + '">' +
        '<button class="episode-play" type="button" data-play-id="' + ep.id + '" aria-label="Play ' + escapeHtml(ep.title) + '">' +
          (ep.id === currentId && !audio.paused ? "&#10074;&#10074;" : "&#9654;") +
        '</button>' +
        (ep.cover_url ? '<img class="episode-art" src="' + mediaUrl(ep.cover_url) + '" alt="" loading="lazy">' : '') +
        '<div class="episode-body">' +
          '<p class="episode-num">Episode ' + (episodes.length - i) + '</p>' +
          '<h4>' + escapeHtml(ep.title) + '</h4>' +
          '<p class="fine-print">' + formatDate(ep.published_at) + '</p>' +
          (ep.description ? '<p class="episode-desc">' + escapeHtml(ep.description) + '</p>' : '') +
        '</div>' +
      '</article>';
    }).join("");
  }

  function renderPublicArticles(rows) {
    if (!publicArticleList) return;
    if (!rows.length) {
      publicArticleList.innerHTML = '<p class="fine-print">No articles published yet.</p>';
      return;
    }
    publicArticleList.innerHTML = rows.map(function (ar) {
      return '<article class="article-card">' +
        (ar.cover_url ? '<img class="article-art" src="' + mediaUrl(ar.cover_url) + '" alt="" loading="lazy">' : '') +
        '<div>' +
          '<h4>' + escapeHtml(ar.title) + '</h4>' +
          '<p class="fine-print">' + formatDate(ar.published_at) + '</p>' +
          '<p>' + escapeHtml(ar.body).replace(/\n/g, "<br>") + '</p>' +
        '</div>' +
      '</article>';
    }).join("");
  }

  function loadEpisode(id, autoplay) {
    var ep = episodes.filter(function (e) { return e.id === id; })[0];
    if (!ep || !playerEl) return;
    currentId = id;
    playerEl.hidden = false;
    document.getElementById("playerError").hidden = true;
    document.getElementById("playerTitle").textContent = ep.title;
    document.getElementById("playerDesc").textContent = ep.description || "";

    var art = document.getElementById("playerArt");
    var fallback = document.getElementById("playerArtFallback");
    if (ep.cover_url) {
      art.src = mediaUrl(ep.cover_url);
      art.hidden = false;
      fallback.hidden = true;
    } else {
      art.hidden = true;
      fallback.hidden = false;
    }

    var dl = document.getElementById("playerDownload");
    dl.href = mediaUrl(ep.audio_url);
    dl.setAttribute("download", ep.title.replace(/[^\w.-]+/g, "_") + ".mp3");

    audio.src = mediaUrl(ep.audio_url);
    audio.playbackRate = SPEEDS[speedIndex];
    if (autoplay) {
      audio.play().catch(function () {
        document.getElementById("playerError").hidden = false;
      });
    }
    renderPublicEpisodes();
  }

  function loadPublicPodcast() {
    if (!publicEpisodeList) return;
    fetch(API_BASE + "/podcast/episodes")
      .then(function (res) { return res.json(); })
      .then(function (data) {
        episodes = (data && data.episodes) || [];
        renderPublicEpisodes();
      })
      .catch(function () {
        publicEpisodeList.innerHTML = '<p class="media-error">Could not load episodes.</p>';
      });

    fetch(API_BASE + "/podcast/articles")
      .then(function (res) { return res.json(); })
      .then(function (data) { renderPublicArticles((data && data.articles) || []); })
      .catch(function () {
        publicArticleList.innerHTML = '<p class="media-error">Could not load articles.</p>';
      });
  }

  if (playerEl && audio) {
    var toggleBtn = document.getElementById("playerToggle");
    var seek = document.getElementById("playerSeek");
    var currentEl = document.getElementById("playerCurrent");
    var durationEl = document.getElementById("playerDuration");
    var speedBtn = document.getElementById("playerSpeed");
    var volume = document.getElementById("playerVolume");
    var seeking = false;

    toggleBtn.addEventListener("click", function () {
      if (!audio.src) { if (episodes.length) loadEpisode(episodes[0].id, true); return; }
      audio.paused ? audio.play().catch(function () {}) : audio.pause();
    });

    document.getElementById("playerBack").addEventListener("click", function () {
      audio.currentTime = Math.max(0, audio.currentTime - 15);
    });
    document.getElementById("playerFwd").addEventListener("click", function () {
      audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 30);
    });

    speedBtn.addEventListener("click", function () {
      speedIndex = (speedIndex + 1) % SPEEDS.length;
      audio.playbackRate = SPEEDS[speedIndex];
      speedBtn.innerHTML = SPEEDS[speedIndex] + "&times;";
    });

    volume.addEventListener("input", function () { audio.volume = volume.value / 100; });

    seek.addEventListener("input", function () { seeking = true; });
    seek.addEventListener("change", function () {
      if (audio.duration) audio.currentTime = (seek.value / 1000) * audio.duration;
      seeking = false;
    });

    audio.addEventListener("loadedmetadata", function () {
      durationEl.textContent = fmtTime(audio.duration);
    });
    audio.addEventListener("timeupdate", function () {
      currentEl.textContent = fmtTime(audio.currentTime);
      if (!seeking && audio.duration) seek.value = Math.round((audio.currentTime / audio.duration) * 1000);
    });
    audio.addEventListener("play", function () {
      toggleBtn.textContent = "Pause";
      toggleBtn.setAttribute("aria-label", "Pause");
      renderPublicEpisodes();
    });
    audio.addEventListener("pause", function () {
      toggleBtn.textContent = "Play";
      toggleBtn.setAttribute("aria-label", "Play");
      renderPublicEpisodes();
    });
    audio.addEventListener("error", function () {
      document.getElementById("playerError").hidden = false;
    });
    // Auto-advance to the next newer episode when one finishes.
    audio.addEventListener("ended", function () {
      var idx = episodes.findIndex(function (e) { return e.id === currentId; });
      if (idx > 0) loadEpisode(episodes[idx - 1].id, true);
    });

    if (publicEpisodeList) {
      publicEpisodeList.addEventListener("click", function (e) {
        var btn = e.target.closest("button[data-play-id]");
        if (!btn) return;
        var id = parseInt(btn.getAttribute("data-play-id"), 10);
        if (id === currentId) {
          audio.paused ? audio.play().catch(function () {}) : audio.pause();
        } else {
          loadEpisode(id, true);
        }
      });
    }
  }

  loadPublicPodcast();


  // --- Media Server control panel ---
  var RELAY_BASE = API_BASE;
  var TOKEN_KEY = "vdj_media_token";

  var gate = document.getElementById("mediaLocked");
  var panel = document.getElementById("mediaPanel");
  var tokenInput = document.getElementById("mediaToken");
  var unlockBtn = document.getElementById("mediaUnlock");
  var gateError = document.getElementById("mediaGateError");
  var lockBtn = document.getElementById("mediaLock");
  var refreshBtn = document.getElementById("mediaRefresh");
  var statusDot = document.getElementById("mediaStatusDot");
  var statusText = document.getElementById("mediaStatusText");
  var actionLog = document.getElementById("mediaActionLog");

  if (!gate || !panel) return; // section not present on this page

  function getToken() { return sessionStorage.getItem(TOKEN_KEY) || ""; }
  function setToken(t) { sessionStorage.setItem(TOKEN_KEY, t); }
  function clearToken() { sessionStorage.removeItem(TOKEN_KEY); }

  function log(msg) {
    var time = new Date().toLocaleTimeString();
    actionLog.textContent = "[" + time + "] " + msg;
  }

  function setStatus(state, text) {
    statusDot.classList.remove("online", "offline");
    if (state) statusDot.classList.add(state);
    statusText.textContent = text;
  }

  function apiCall(path, opts) {
    opts = opts || {};
    var url = RELAY_BASE + path + (path.indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(getToken());
    return fetch(url, { method: opts.method || "GET" }).then(function (res) {
      return res.json().then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
    });
  }

  function checkHealth() {
    setStatus(null, "Checking connection…");
    return fetch(RELAY_BASE + "/health")
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.agentConnected) {
          setStatus("online", "Relay connected — VirtualDJ agent online");
        } else {
          setStatus("offline", "Relay reachable, but VirtualDJ agent is offline");
        }
        return true;
      })
      .catch(function () {
        setStatus("offline", "Could not reach the relay server");
        return false;
      });
  }

  function showPanel() {
    gate.hidden = true;
    panel.hidden = false;
    checkHealth();
  }

  function tryUnlock() {
    var t = tokenInput.value.trim();
    if (!t) return;
    gateError.hidden = true;
    setToken(t);
    // Validate the token against a real endpoint before granting access.
    apiCall("/history?limit=1").then(function (result) {
      if (result.status === 401) {
        clearToken();
        gateError.hidden = false;
        return;
      }
      showPanel();
    }).catch(function () {
      // Relay unreachable entirely — still allow entry, health check will show it.
      showPanel();
    });
  }

  unlockBtn.addEventListener("click", tryUnlock);
  tokenInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") tryUnlock();
  });

  lockBtn.addEventListener("click", function () {
    clearToken();
    panel.hidden = true;
    gate.hidden = false;
    tokenInput.value = "";
  });

  refreshBtn.addEventListener("click", checkHealth);

  panel.addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-action]");
    if (!btn) return;
    var action = btn.getAttribute("data-action");
    var promise;

    if (action === "transport") {
      var deck = btn.getAttribute("data-deck");
      var transport = btn.getAttribute("data-transport");
      log("Sending: deck " + deck + " → " + transport + " …");
      promise = apiCall("/transport?deck=" + deck + "&action=" + transport);
    } else if (action === "mix_now") {
      log("Sending: Mix Now …");
      promise = apiCall("/mix_now", { method: "POST" });
    } else if (action === "emergency_play") {
      log("Sending: Emergency Play …");
      promise = apiCall("/emergency_play", { method: "POST" });
    } else {
      return;
    }

    promise.then(function (result) {
      if (result.ok) {
        log("OK: " + JSON.stringify(result.data));
      } else {
        log("Error (" + result.status + "): " + (result.data && result.data.error ? result.data.error : "request failed"));
      }
    }).catch(function (err) {
      log("Network error: " + err.message);
    });
  });

  // If a token is already stored for this browser session, skip the gate.
  if (getToken()) showPanel();
});
