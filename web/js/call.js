/* ==========================================================================
   Звонки «Контур»: WebRTC-меш (аудио/видео/демонстрация экрана)
   --------------------------------------------------------------------------
   Что внутри:
     • perfect negotiation — офферы не конфликтуют, соединение не «залипает»;
     • выбор микрофона/камеры/динамиков из настроек;
     • демонстрация экрана с повышением битрейта и корректным пересогласованием;
     • перезапуск ICE при обрыве, автоматическое восстановление;
     • понятные сообщения об ошибках (нет HTTPS, нет доступа к камере и т.п.);
     • индикация «говорит», плитки участников, свёрнутый режим.
   ========================================================================== */
(function () {
  'use strict';
  const K = window.K || {};
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const DEFAULT_ICE = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];

  const C = {
    call: null,
    localStream: null,
    camTrack: null,
    micTrack: null,
    screenStream: null,
    peers: new Map(),      // userId -> entry
    incoming: null,
    active: false,
    muted: false,
    camOn: false,
    sharing: false,
    effect: 'none',
    effectCanvas: null,
    effectRAF: null,
    effectSource: null,
    startedAt: 0,
    timer: null,
    ring: null,
    mini: null,
    speakingTimer: null,
    audioCtx: null,
  };

  const me = () => (K.S && K.S.me ? K.S.me.id : null);
  const S = () => K.S || { settings: {}, chats: new Map(), users: new Map(), me: null };
  const ws = (obj) => (window.__konturSend ? window.__konturSend(obj) : false);
  const toast = (t, k, ms) => K.toast && K.toast(t, k, ms);
  const esc = (v) => (K.esc ? K.esc(v) : String(v == null ? '' : v));

  function userOf(userId) {
    const s = S();
    if (s.me && s.me.id === userId) return s.me;
    const u = s.users && s.users.get(userId);
    if (u) return u;
    for (const chat of (s.chats || new Map()).values()) {
      const m = (chat.members || []).find((x) => x.id === userId);
      if (m) return m;
    }
    return { displayName: 'Участник', color: '#6c8cff' };
  }

  /* ------------------------------------------------------------- окружение */

  function mediaSupportProblem() {
    if (K.mediaProblem) return K.mediaProblem();   // единый текст и решение (см. app.js)
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const insecure = location.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(location.hostname);
      return insecure
        ? 'Браузер запрещает доступ к камере и микрофону по http:// вне localhost. Запустите сервер с флагом --https (тогда откроется https://…) или запустите приложение: KonturServer.exe --server ' + location.origin + '.'
        : 'Этот браузер не умеет работать с камерой и микрофоном (нужен Chrome, Edge, Firefox или Safari).';
    }
    if (!window.RTCPeerConnection) return 'Браузер не поддерживает WebRTC — звонки недоступны.';
    return null;
  }

  function iceServers() {
    const extra = (S().settings && S().settings.iceServers) || [];
    return [...DEFAULT_ICE, ...extra];
  }

  /* ----------------------------------------------------------------- рингтон */

  function startRing() {
    if (!(S().settings && S().settings.sounds)) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const play = () => {
        const t = ctx.currentTime;
        for (const off of [0, .45]) {
          const osc = ctx.createOscillator(), g = ctx.createGain();
          osc.type = 'triangle'; osc.frequency.value = 620;
          g.gain.setValueAtTime(0, t + off);
          g.gain.linearRampToValueAtTime(.12, t + off + .03);
          g.gain.exponentialRampToValueAtTime(.0001, t + off + .38);
          osc.connect(g).connect(ctx.destination);
          osc.start(t + off); osc.stop(t + off + .4);
        }
      };
      play();
      C.ring = { ctx, interval: setInterval(play, 1800) };
    } catch {}
  }
  function stopRing() {
    if (!C.ring) return;
    clearInterval(C.ring.interval);
    try { C.ring.ctx.close(); } catch {}
    C.ring = null;
  }

  /* -------------------------------------------------------------- входящий */

  function start(chatId, kind) {
    const problem = mediaSupportProblem();
    if (problem) { toast(problem, 'err', 9000); return; }
    if (C.active) { toast('Вы уже разговариваете — сначала завершите текущий звонок'); show(); return; }
    ws({ type: 'call:invite', payload: { chatId, kind } });
    toast(kind === 'audio' ? '📞 Создаю аудиозвонок…' : '🎥 Создаю видеозвонок…');
  }

  function showIncoming(payload) {
    if (C.active) { ws({ type: 'call:decline', payload: { callId: payload.call.id } }); return; }
    C.incoming = payload.call;
    stopRing(); startRing();
    if (K.beep) K.beep('ring');
    $('#incoming').hidden = false;
    const from = userOf(payload.call.from);
    $('#incoming-avatar').outerHTML = K.avatarHTML(from, 'lg', false, 'incoming-avatar');
    $('#incoming-name').textContent = from.displayName;
    const chat = payload.chat || S().chats.get(payload.call.chatId);
    $('#incoming-sub').textContent = (payload.call.kind === 'audio' ? 'аудиозвонок' : 'видеозвонок') +
      (chat && chat.type === 'group' ? ' в группе «' + chat.title + '»' : '');
    try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch {}
    if (S().settings.notifications && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification('Входящий звонок', { body: from.displayName, icon: '/icon-192.png', tag: 'call' }); } catch {}
    }
  }

  async function accept() {
    const call = C.incoming;
    $('#incoming').hidden = true;
    stopRing();
    if (!call) return;
    const problem = mediaSupportProblem();
    if (problem) { toast(problem, 'err', 9000); ws({ type: 'call:decline', payload: { callId: call.id } }); return; }
    C.incoming = null;
    ws({ type: 'call:join', payload: { callId: call.id } });
  }

  function decline() {
    const call = C.incoming;
    $('#incoming').hidden = true;
    stopRing();
    C.incoming = null;
    if (call) ws({ type: 'call:decline', payload: { callId: call.id } });
  }

  /* ------------------------------------------------------------------ медиа */

  function deviceConstraints(kind) {
    const d = (S().settings && S().settings.devices) || {};
    const audio = Object.assign(
      { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      d.audioIn ? { deviceId: { exact: d.audioIn } } : {}
    );
    const video = kind === 'video'
      ? Object.assign({ width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
          d.videoIn ? { deviceId: { exact: d.videoIn } } : {})
      : false;
    return { audio, video };
  }

  async function getMedia(kind) {
    try {
      return await navigator.mediaDevices.getUserMedia(deviceConstraints(kind));
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        toast('Доступ к камере/микрофону запрещён — разрешите его в адресной строке браузера', 'err', 8000);
        return null;
      }
      if (kind === 'video') {
        toast('Камера недоступна (' + err.name + '), подключаюсь без видео', 'err', 6000);
        try {
          const d = (S().settings && S().settings.devices) || {};
          return await navigator.mediaDevices.getUserMedia({ audio: Object.assign({ echoCancellation: true }, d.audioIn ? { deviceId: { exact: d.audioIn } } : {}) });
        } catch { return null; }
      }
      toast('Микрофон недоступен: ' + err.message, 'err', 7000);
      return null;
    }
  }

  /* ------------------------------------------------- perfect negotiation (mesh) */

  function createPeer(userId) {
    if (C.peers.has(userId)) return C.peers.get(userId);
    const pc = new RTCPeerConnection({ iceServers: iceServers(), iceCandidatePoolSize: 4, bundlePolicy: 'max-bundle' });
    const entry = {
      pc, userId, stream: null, tile: null, videoEl: null,
      chain: Promise.resolve(),        // очередь сигналинга: описания обрабатываются по одному
      closed: false,
      polite: String(me()) < String(userId),          // «вежливая» сторона уступает при конфликте офферов
      makingOffer: false, ignoreOffer: false, settingRemoteAnswer: false,
      audioEl: null, analyser: null, level: 0, restarting: false,
    };
    C.peers.set(userId, entry);

    if (C.localStream) for (const track of C.localStream.getTracks()) pc.addTrack(track, C.localStream);
    if (C.effect !== 'none' && entry.camTrack) { /* обработка включается позже */ }

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) ws({ type: 'call:signal', payload: { callId: C.call.id, to: userId, data: { candidate } } });
    };

    pc.ontrack = ({ track, streams }) => {
      entry.stream = streams[0] || new MediaStream([track]);
      attachRemote(userId, entry.stream);
    };

    // Согласование параметров соединения (совместимо и с браузерами, и с неполными реализациями WebRTC)
    const negotiate = async () => {
      if (!C.call || !entry.pc || entry.closed) return;
      if (entry.makingOffer) return;
      if (pc.signalingState !== 'stable') {
        // канал занят другим обменом описаниями — подождём и попробуем снова
        entry.negRetries = (entry.negRetries || 0) + 1;
        if (entry.negRetries > 30) return;
        clearTimeout(entry.negTimer);
        entry.negTimer = setTimeout(negotiate, 250);
        return;
      }
      entry.negRetries = 0;
      await enqueue(entry, async () => {
        try {
          entry.makingOffer = true;
          const offer = await pc.createOffer();
          if (pc.signalingState !== 'stable') return;   // за время подготовки пришёл встречный оффер
          await pc.setLocalDescription(offer);
          ws({ type: 'call:signal', payload: { callId: C.call.id, to: userId, data: { description: pc.localDescription } } });
        } catch (err) {
          console.warn('[call] negotiation', err && err.message || err);
        } finally {
          entry.makingOffer = false;
        }
      });
    };
    pc.onnegotiationneeded = negotiate;
    entry.negotiate = negotiate;

    pc.ontrack = ({ track, streams }) => {
      entry.stream = streams[0] || new MediaStream([track]);
      attachRemote(userId, entry.stream);
    };

    pc.onnegotiationneeded = async () => {
      if (!C.call || entry.makingOffer) return;
      // канал занят другим обменом описаниями — подождём и попробуем снова
      if (pc.signalingState !== 'stable') {
        entry.negRetries = (entry.negRetries || 0) + 1;
        if (entry.negRetries > 20) return;
        clearTimeout(entry.negTimer);
        entry.negTimer = setTimeout(() => pc.onnegotiationneeded(), 250);
        return;
      }
      entry.negRetries = 0;
      try {
        entry.makingOffer = true;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);      // явный offer — совместимо со всеми браузерами
        ws({ type: 'call:signal', payload: { callId: C.call.id, to: userId, data: { description: pc.localDescription } } });
      } catch (err) {
        console.warn('[call] negotiation', err);
      } finally {
        entry.makingOffer = false;
      }
    };

    pc.oniceconnectionstatechange = () => {
      const st = pc.iceConnectionState;
      if (st === 'failed') restartIce(userId);
      renderSubtitle();
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'failed' && !entry.restarting) restartIce(userId);
      renderSubtitle();
    };

    return entry;
  }

  async function restartIce(userId) {
    const entry = C.peers.get(userId);
    if (!entry || entry.restarting) return;
    entry.restarting = true;
    try {
      if (typeof entry.pc.restartIce === 'function') entry.pc.restartIce();
      await entry.pc.setLocalDescription(await entry.pc.createOffer({ iceRestart: true }));
      ws({ type: 'call:signal', payload: { callId: C.call.id, to: userId, data: { description: entry.pc.localDescription } } });
      toast('Переподключаю ' + (userOf(userId).displayName || 'участника') + '…');
    } catch (err) {
      console.warn('[call] ice restart', err);
    } finally {
      setTimeout(() => { const e = C.peers.get(userId); if (e) e.restarting = false; }, 5000);
    }
  }

  /**
   * Сигналинг — строго по очереди.
   * Если обрабатывать описания параллельно, при одновременных офферах (glare)
   * состояние соединения разъезжается и звонок не поднимается: одно описание
   * успевает перевести pc в have-local-offer, пока другое ещё «в полёте».
   */
  function enqueue(entry, task) {
    entry.chain = (entry.chain || Promise.resolve())
      .then(task)
      .catch((err) => console.warn('[call] сигналинг', err && err.message || err));
    return entry.chain;
  }

  async function applyDescription(entry, description) {
    const pc = entry.pc;
    if (!pc || pc.signalingState === 'closed' || entry.closed) return;

    const readyForOffer = !entry.makingOffer && (pc.signalingState === 'stable' || entry.settingRemoteAnswer);
    const offerCollision = description.type === 'offer' && !readyForOffer;
    entry.ignoreOffer = !entry.polite && offerCollision;
    if (entry.ignoreOffer) return;   // «настойчивая» сторона пропускает встречный оффер

    if (offerCollision && entry.polite && pc.signalingState === 'have-local-offer') {
      // «вежливая» сторона откатывает свой оффер и принимает чужой
      try { await pc.setLocalDescription({ type: 'rollback' }); } catch (err) { console.warn('[call] rollback', err && err.message || err); }
    }

    if (pc.signalingState === 'have-remote-offer' && description.type === 'offer') return; // уже приняли этот оффер
    if (description.type === 'answer' && pc.signalingState !== 'have-local-offer') return;  // ответ на откатанный оффер — не наш

    entry.settingRemoteAnswer = description.type === 'answer';
    await pc.setRemoteDescription(description);
    entry.settingRemoteAnswer = false;

    if (description.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws({ type: 'call:signal', payload: { callId: C.call.id, to: userIdOf(entry), data: { description: pc.localDescription } } });
    }
  }

  function userIdOf(entry) {
    for (const [id, e] of C.peers) if (e === entry) return id;
    return entry.userId;
  }

  function onDescription(userId, description) {
    const entry = createPeer(userId);
    entry.userId = userId;
    return enqueue(entry, () => applyDescription(entry, description));
  }

  function onCandidate(userId, candidate) {
    const entry = createPeer(userId);
    return enqueue(entry, async () => {
      if (entry.closed || entry.pc.signalingState === 'closed') return;
      await entry.pc.addIceCandidate(candidate);
    });
  }

  /* ------------------------------------------------------------------ плитки */

  function makeTile(userId, isLocal) {
    const grid = $('#call-grid');
    const user = isLocal ? S().me : userOf(userId);
    const safeName = esc((user && user.displayName) || 'Участник');
    const tile = document.createElement('div');
    tile.className = 'call-tile';
    tile.dataset.user = userId;
    tile.innerHTML = `
      <div class="tile-fallback">${K.avatarHTML(user && !user.isBot ? user : { displayName: safeName, color: '#6c8cff' }, 'lg')}
        <div class="tile-fallback-name">${safeName}</div></div>
      <video autoplay playsinline ${isLocal ? 'muted' : ''}></video>
      <div class="tile-name"><span class="tile-label">${isLocal ? 'Вы' : safeName}</span><span class="tile-flags"></span></div>
      <div class="tile-badge" hidden>демонстрация экрана</div>
      <div class="tile-state" hidden></div>`;
    grid.appendChild(tile);
    return { tile, videoEl: tile.querySelector('video') };
  }

  function attachRemote(userId, stream) {
    const entry = C.peers.get(userId);
    if (!entry) return;
    if (!entry.tile) {
      const made = makeTile(userId, false);
      entry.tile = made.tile; entry.videoEl = made.videoEl;
    }
    entry.videoEl.srcObject = stream;
    entry.videoEl.play().catch(() => {});
    applyOutputDevice(entry.videoEl);
    startLevelMeter(entry);
    renderTiles();
  }

  function applyOutputDevice(el) {
    const id = (S().settings && S().settings.devices && S().settings.devices.audioOut) || '';
    if (id && typeof el.setSinkId === 'function') el.setSinkId(id).catch(() => {});
  }

  /** Кто сейчас говорит — подсвечиваем плитку. */
  function startLevelMeter(entry) {
    if (entry.analyser) return;
    try {
      C.audioCtx = C.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const src = C.audioCtx.createMediaStreamSource(entry.stream);
      const analyser = C.audioCtx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      entry.analyser = analyser;
      entry.data = new Uint8Array(analyser.fftSize);
    } catch { /* без индикатора */ }
  }

  function tickLevels() {
    for (const [, entry] of C.peers) {
      if (!entry.analyser || !entry.tile) continue;
      entry.analyser.getByteTimeDomainData(entry.data);
      let peak = 0;
      for (const v of entry.data) peak = Math.max(peak, Math.abs(v - 128) / 128);
      entry.tile.classList.toggle('speaking', peak > 0.12);
    }
  }

  function renderTiles() {
    if (!C.call) return;
    const grid = $('#call-grid');
    const ids = [me(), ...C.call.participants.map((p) => p.userId).filter((id) => id !== me())];
    for (const tile of [...grid.querySelectorAll('.call-tile')]) {
      const uid = tile.dataset.user;
      if (!ids.includes(uid)) { tile.remove(); const e = C.peers.get(uid); if (e) { try { e.pc.close(); } catch {} C.peers.delete(uid); } }
    }
    for (const id of ids) {
      const isLocal = id === me();
      const p = isLocal
        ? { camera: C.camOn, muted: C.muted, screen: C.sharing }
        : (C.call.participants.find((x) => x.userId === id) || {});
      let entry = isLocal ? null : C.peers.get(id);
      let tile = grid.querySelector(`.call-tile[data-user="${id}"]`);
      if (!tile) {
        const made = makeTile(id, isLocal);
        tile = made.tile;
        if (isLocal) {
          if (C.localStream) made.videoEl.srcObject = C.localStream;
        } else {
          entry = C.peers.get(id);
          if (entry) {
            entry.tile = made.tile; entry.videoEl = made.videoEl;
            if (entry.stream) { made.videoEl.srcObject = entry.stream; made.videoEl.play().catch(() => {}); }
            else {
              makeTilePending(made.tile, true);
            }
          } else {
            makeTilePending(made.tile, false);      // приглашён, но ещё не подключился
          }
        }
      }
      const videoEl = tile.querySelector('video');
      const showVideo = isLocal ? (C.camOn || C.sharing) : (p.camera !== false || p.screen);
      videoEl.style.display = showVideo ? 'block' : 'none';
      tile.querySelector('.tile-fallback').style.display = showVideo ? 'none' : 'grid';
      const flags = tile.querySelector('.tile-flags');
      if (flags) flags.textContent = (p.muted ? ' 🔇' : '') + (p.screen ? ' 🖥' : '');
      tile.classList.toggle('screen', !!p.screen);
      const badge = tile.querySelector('.tile-badge');
      badge.hidden = !p.screen;
      const state = tile.querySelector('.tile-state');
      const connected = isLocal ? true : !!(entry && entry.pc.connectionState === 'connected');
      if (!isLocal && state) {
        if (!entry) { state.hidden = false; state.textContent = 'звоним…'; }
        else if (!connected && entry.pc.connectionState !== 'connected') {
          state.hidden = false;
          state.textContent = entry.pc.connectionState === 'failed' ? 'нет связи' : 'соединение…';
        } else state.hidden = true;
      }
    }
    const n = ids.length;
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
    grid.style.gridTemplateColumns = `repeat(${cols}, minmax(240px, 1fr))`;
    grid.style.gridTemplateRows = n > 4 ? `repeat(${Math.ceil(n / cols)}, minmax(160px, 1fr))` : '';
    renderSubtitle();
  }

  function makeTilePending(tile, connecting) {
    const state = tile.querySelector('.tile-state');
    if (state) { state.hidden = false; state.textContent = connecting ? 'соединение…' : 'звоним…'; }
  }

  function renderSubtitle() {
    if (!C.call) return;
    const chat = S().chats.get(C.call.chatId);
    $('#call-title').textContent = (chat ? chat.title : 'Звонок') + (C.call.kind === 'audio' ? ' · аудио' : ' · видео');
    const secs = C.startedAt ? Math.round((Date.now() - C.startedAt) / 1000) : 0;
    const connected = [...C.peers.values()].filter((e) => e.pc.connectionState === 'connected').length;
    const bad = [...C.peers.values()].some((e) => ['failed', 'disconnected'].includes(e.pc.connectionState));
    const parts = [`${fmtDur(secs)}`, `участников: ${C.call.participants.length}`];
    if (C.peers.size) parts.push(`на связи: ${connected}/${C.peers.size}`);
    if (bad) parts.push('⚠️ нестабильное соединение');
    if (C.sharing) parts.push('🖥 ваш экран в эфире');
    $('#call-sub').textContent = parts.join(' · ');
  }

  function fmtDur(sec) {
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  /* ---------------------------------------------------------------- эффекты */

  const EFFECTS = { none: '', blur: 'blur', grayscale: 'grayscale(1)', sepia: 'sepia(.7)', warm: 'saturate(1.35) hue-rotate(-10deg)', cool: 'saturate(1.2) hue-rotate(16deg)', vintage: 'contrast(1.12) sepia(.32) saturate(1.15)' };

  function applyEffect(mode) {
    C.effect = mode;
    const rawTrack = C.localStream ? C.localStream.getVideoTracks()[0] : null;
    const localVideo = $(`.call-tile[data-user="${me()}"] video`);

    const stopProcessor = () => {
      if (C.effectRAF) cancelAnimationFrame(C.effectRAF);
      C.effectRAF = null;
      if (C.effectSource) { try { C.effectSource.pause(); } catch {} C.effectSource = null; }
      if (C.effectCanvas) { C.effectCanvas.remove(); C.effectCanvas = null; }
      for (const entry of C.peers.values()) {
        const sender = entry.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
        if (sender && rawTrack) sender.replaceTrack(rawTrack).catch(() => {});
      }
      if (localVideo && C.localStream) { localVideo.srcObject = C.localStream; localVideo.style.filter = ''; }
    };

    if (mode === 'none' || !rawTrack) { stopProcessor(); if (mode !== 'none') toast('Эффект выключен'); return; }

    if (!C.effectCanvas) {
      const c = document.createElement('canvas');
      c.width = 1280; c.height = 720; c.style.display = 'none';
      document.body.appendChild(c);
      C.effectCanvas = c;
    }
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.srcObject = new MediaStream([rawTrack]);
    video.play().catch(() => {});
    C.effectSource = video;
    const canvas = C.effectCanvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    const filter = EFFECTS[C.effect] || '';

    const draw = () => {
      if (!C.effectCanvas || C.effectSource !== video) return;
      const w = video.videoWidth || 1280, h = video.videoHeight || 720;
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      if (C.effect === 'blur') {
        // фон размыт, лицо в центре — резкое
        ctx.filter = 'blur(0px)';
        ctx.drawImage(video, 0, 0, w, h);
        ctx.filter = 'blur(0px)';
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(w / 2, h * 0.52, w * 0.24, h * 0.44, 0, 0, Math.PI * 2);
        ctx.clip();
        ctx.filter = 'none';
        ctx.drawImage(video, 0, 0, w, h);
        ctx.restore();
        // лёгкое размытие вне овала
        ctx.filter = 'blur(0px)';
      } else {
        ctx.filter = filter;
        ctx.drawImage(video, 0, 0, w, h);
        ctx.filter = 'none';
      }
      C.effectRAF = requestAnimationFrame(draw);
    };
    draw();

    const stream = canvas.captureStream(30);
    const processed = stream.getVideoTracks()[0];
    if (processed.setContentHint) processed.contentHint = 'motion';
    for (const entry of C.peers.values()) {
      const sender = entry.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) sender.replaceTrack(processed).catch(() => {});
    }
    if (localVideo) { localVideo.srcObject = stream; localVideo.style.filter = ''; }
    const titles = { blur: 'размытый фон', grayscale: 'ч/б', sepia: 'сепия', warm: 'тёплый', cool: 'холодный', vintage: 'винтаж' };
    toast('Эффект: ' + (titles[mode] || mode));
  }

  function cycleEffect() {
    const modes = Object.keys(EFFECTS);
    applyEffect(modes[(modes.indexOf(C.effect) + 1) % modes.length]);
  }

  /* ------------------------------------------------------------------- старт */

  async function beginLocal(call) {
    C.call = call;
    C.active = true;
    C.startedAt = Date.now();
    $('#call-screen').hidden = false;
    hideMini();
    $('#call-grid').innerHTML = '';
    C.peers.clear();

    C.localStream = await getMedia(call.kind);
    if (C.localStream) {
      C.micTrack = C.localStream.getAudioTracks()[0] || null;
      C.camTrack = C.localStream.getVideoTracks()[0] || null;
      C.camOn = !!C.camTrack;
      C.muted = !C.micTrack;
    } else {
      C.camOn = false;
      C.muted = true;
      toast('Подключаюсь без своего звука и видео', 'err', 6000);
    }
    $('#ctl-cam').classList.toggle('off', !C.camOn);
    $('#ctl-mic').classList.toggle('off', C.muted);
    renderTiles();
    ws({ type: 'call:state', payload: { callId: call.id, state: { muted: C.muted, camera: C.camOn } } });
    clearInterval(C.timer);
    C.timer = setInterval(renderSubtitle, 1000);
    clearInterval(C.speakingTimer);
    C.speakingTimer = setInterval(tickLevels, 250);
    renderSubtitle();
  }

  async function onJoined(payload) {
    const call = payload.call;
    const peers = payload.existingPeers || [];
    await beginLocal(call);
    for (const peerId of peers) {
      if (peerId === me()) continue;
      createPeer(peerId);          // оффер уйдёт сам через onnegotiationneeded (perfect negotiation)
    }
    renderTiles();
  }

  async function onPeerJoined(payload) {
    if (!C.call) return;
    C.call = payload.call || C.call;
    const peerId = payload.userId;
    if (peerId === me()) return;
    if (!C.peers.has(peerId)) createPeer(peerId);
    renderTiles();
    toast((userOf(peerId).displayName || 'Участник') + ' присоединился(ась)');
  }

  async function onSignal(payload) {
    if (!C.call || payload.callId !== C.call.id) return;
    const from = payload.from;
    const data = payload.data || {};
    if (data.bye) {
      const e = C.peers.get(from);
      if (e) { try { e.pc.close(); } catch {} C.peers.delete(from); if (e.tile) e.tile.remove(); }
      renderTiles();
      return;
    }
    if (data.description) return onDescription(from, data.description);
    if (data.candidate) return onCandidate(from, data.candidate);
    // совместимость со старым форматом
    if (data.sdp) return onDescription(from, data.sdp);
  }

  /* -------------------------------------------------------------- управление */

  function toggleMic() {
    if (!C.localStream) { toast('Микрофон недоступен', 'err'); return; }
    if (!C.micTrack) { toast('В этом звонке нет микрофона', 'err'); return; }
    C.muted = !C.muted;
    C.micTrack.enabled = !C.muted;
    $('#ctl-mic').classList.toggle('off', C.muted);
    ws({ type: 'call:state', payload: { callId: C.call.id, state: { muted: C.muted } } });
    renderTiles();
  }

  function toggleCam() {
    if (!C.localStream || !C.camTrack) { toast('Камера недоступна'); return; }
    C.camOn = !C.camOn;
    C.camTrack.enabled = C.camOn;
    $('#ctl-cam').classList.toggle('off', !C.camOn);
    ws({ type: 'call:state', payload: { callId: C.call.id, state: { camera: C.camOn } } });
    renderTiles();
  }

  async function setVideoOnPeers(track, stream) {
    for (const entry of C.peers.values()) {
      const sender = entry.pc.getSenders().find((s) => s.kind === 'video');
      if (sender) {
        await sender.replaceTrack(track).catch(() => {});
        tuneSender(sender, track === C.screenStreamTrack ? 'screen' : 'camera');
      } else {
        // у собеседника ещё нет видеолинии (аудиозвонок) — добавляем и пересогласуем
        entry.pc.addTrack(track, stream);
      }
    }
  }

  function tuneSender(sender, mode) {
    try {
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      if (mode === 'screen') {
        p.encodings[0].maxBitrate = 2500000;
        p.encodings[0].maxFramerate = 30;
        p.degradationPreference = 'maintain-resolution';
      } else {
        p.encodings[0].maxBitrate = 900000;
        p.encodings[0].maxFramerate = 30;
        p.degradationPreference = 'balanced';
      }
      sender.setParameters(p).catch(() => {});
    } catch {}
  }

  async function toggleScreen() {
    if (!C.call) return;
    if (C.sharing) return stopScreen();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      toast('Этот браузер не умеет показывать экран. В приложении (.exe) демонстрация доступна через системное окно Windows.', 'err', 8000);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      C.screenStream = stream;
      const track = stream.getVideoTracks()[0];
      if (track.setContentHint) track.contentHint = 'detail';
      C.screenStreamTrack = track;
      C.sharing = true;
      await setVideoOnPeers(track, stream);
      const localVideo = $(`.call-tile[data-user="${me()}"] video`);
      if (localVideo) { localVideo.srcObject = stream; localVideo.play().catch(() => {}); }
      $('#ctl-screen').classList.add('active');
      ws({ type: 'call:state', payload: { callId: C.call.id, state: { screen: true } } });
      track.onended = () => stopScreen();
      renderTiles();
      toast('Демонстрация экрана началась 🖥', 'ok');
    } catch (err) {
      if (err.name === 'NotAllowedError') toast('Демонстрация отменена: нужно выбрать окно или экран в системном окне');
      else toast('Не удалось начать демонстрацию: ' + err.message, 'err', 7000);
    }
  }

  async function stopScreen() {
    if (!C.sharing) return;
    C.sharing = false;
    if (C.screenStream) for (const t of C.screenStream.getTracks()) t.stop();
    C.screenStream = null;
    C.screenStreamTrack = null;
    const camTrack = C.localStream ? C.localStream.getVideoTracks()[0] : null;
    if (camTrack) await setVideoOnPeers(camTrack, C.localStream);
    const localVideo = $(`.call-tile[data-user="${me()}"] video`);
    if (localVideo && C.localStream) { localVideo.srcObject = C.localStream; localVideo.play().catch(() => {}); }
    if (C.effect !== 'none' && camTrack) setTimeout(() => applyEffect(C.effect), 50);
    $('#ctl-screen').classList.remove('active');
    if (C.call) ws({ type: 'call:state', payload: { callId: C.call.id, state: { screen: false } } });
    renderTiles();
  }

  function hangup() {
    if (!C.call) return teardown();
    ws({ type: 'call:leave', payload: { callId: C.call.id } });
    teardown();
  }

  function teardown() {
    if (C.call) for (const [uid] of C.peers) ws({ type: 'call:signal', payload: { callId: C.call.id, to: uid, data: { bye: true } } });
    stopRing();
    for (const [, entry] of C.peers) { try { entry.pc.close(); } catch {} }
    C.peers.clear();
    if (C.effectRAF) cancelAnimationFrame(C.effectRAF);
    if (C.effectCanvas) C.effectCanvas.remove();
    if (C.localStream) for (const t of C.localStream.getTracks()) t.stop();
    if (C.screenStream) for (const t of C.screenStream.getTracks()) t.stop();
    clearInterval(C.timer);
    clearInterval(C.speakingTimer);
    Object.assign(C, {
      localStream: null, screenStream: null, screenStreamTrack: null, camTrack: null, micTrack: null,
      effectCanvas: null, effectRAF: null, effectSource: null, effect: 'none',
      active: false, call: null, camOn: false, muted: false, sharing: false,
    });
    $('#call-grid').innerHTML = '';
    $('#call-screen').hidden = true;
    $('#incoming').hidden = true;
    ['#ctl-cam', '#ctl-mic', '#ctl-screen'].forEach((sel) => $(sel).classList.remove('off', 'active'));
    hideMini();
    if (K.renderChats) K.renderChats();
  }

  /* -------------------------------------------------------------- мини-окно */

  function minimize() { $('#call-screen').hidden = true; showMini(); }
  function showMini() {
    hideMini();
    const bar = document.createElement('div');
    bar.className = 'call-mini';
    bar.textContent = '🎥 Вернуться к звонку';
    bar.onclick = show;
    document.body.appendChild(bar);
    C.mini = bar;
  }
  function hideMini() { if (C.mini) { C.mini.remove(); C.mini = null; } }
  function show() { hideMini(); $('#call-screen').hidden = false; }

  /* ---------------------------------------------------------------- события */

  function onEvent(type, p) {
    switch (type) {
      case 'call:incoming': showIncoming(p); break;
      case 'call:started': {
        const peers = p.existingPeers || (p.call.participants || []).map((x) => x.userId);
        onJoined({ call: p.call, existingPeers: peers });
        break;
      }
      case 'call:joined': onJoined(p); break;
      case 'call:peer-joined': onPeerJoined(p); break;
      case 'call:peer-left': {
        if (!C.call || p.callId !== C.call.id) break;
        C.call = p.call || C.call;
        if (p.userId !== me()) {
          const e = C.peers.get(p.userId);
          if (e) { try { e.pc.close(); } catch {} C.peers.delete(p.userId); if (e.tile) e.tile.remove(); }
          renderTiles();
          toast((userOf(p.userId).displayName || 'Участник') + ' вышел(ла)');
        }
        break;
      }
      case 'call:peer-declined': if (p.userId !== me()) toast((userOf(p.userId).displayName || 'Участник') + ' отклонил(а) звонок'); break;
      case 'call:ended': {
        if (C.call && C.call.id === p.callId) { toast('Звонок завершён'); teardown(); }
        $('#incoming').hidden = true; stopRing();
        break;
      }
      case 'call:state': {
        if (!C.call || (p.call && p.call.id !== C.call.id)) break;
        C.call = p.call || C.call;
        renderTiles();
        break;
      }
      case 'call:signal': onSignal(p); break;
      default: break;
    }
  }

  /* ------------------------------------------------------------------- кнопки */

  function bind() {
    $('#btn-accept').addEventListener('click', accept);
    $('#btn-decline').addEventListener('click', decline);
    $('#ctl-mic').addEventListener('click', toggleMic);
    $('#ctl-cam').addEventListener('click', toggleCam);
    $('#ctl-screen').addEventListener('click', toggleScreen);
    $('#ctl-effects').addEventListener('click', cycleEffect);
    $('#ctl-hangup').addEventListener('click', hangup);
    $('#btn-call-minimize').addEventListener('click', minimize);
    $$('#call-screen .call-top').forEach((el) => el.addEventListener('dblclick', minimize));
    document.addEventListener('keydown', (e) => {
      if (!C.call) return;
      if (e.key === 'Escape' && !$('#call-screen').hidden) minimize();
      if (e.key.toLowerCase() === 'm' && e.altKey) toggleMic();
    });
    window.addEventListener('beforeunload', () => { if (C.call) ws({ type: 'call:leave', payload: { callId: C.call.id } }); });
  }

  window.K = K;
  window.K.calls = { start, onEvent, accept, decline, hangup, teardown, toggleMic, toggleCam, toggleScreen, cycleEffect, minimize, show, state: C, bind, _internals: { createPeer, onDescription, renderTiles } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
