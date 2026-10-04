/* ==========================================================================
   Звонки: WebRTC mesh (аудио, видео, демонстрация экрана) + эффекты фона
   ========================================================================== */
(function () {
  'use strict';
  const K = window.K || {};
  const $ = (s, r = document) => r.querySelector(s);

  const ICE = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];

  const C = {
    call: null,          // объект звонка с сервера
    localStream: null,
    screenStream: null,
    camTrack: null,
    peers: new Map(),    // userId -> { pc, stream, tile, videoEl, screen }
    incoming: null,
    active: false,
    muted: false,
    camOn: false,
    sharing: false,
    effect: 'none',
    effectCanvas: null,
    effectRAF: null,
    startedAt: 0,
    timer: null,
    ring: null,
    mini: null,
  };

  const me = () => (K.S && K.S.me ? K.S.me.id : null);
  const ws = (obj) => {
    const S = K.S;
    if (!S) return false;
    // используем сокет из app.js через глобальный объект
    return window.__konturSend ? window.__konturSend(obj) : false;
  };
  const toast = (t, k) => K.toast && K.toast(t, k);
  const avatarHTML = (u, c, s, id) => (K.avatarHTML ? K.avatarHTML(u, c, s, id) : '');
  const userOf = (userId) => {
    const S = K.S;
    if (!S) return { displayName: 'Участник', color: '#6c8cff' };
    if (S.me && S.me.id === userId) return S.me;
    const u = S.users.get(userId);
    if (u) return u;
    for (const chat of S.chats.values()) {
      const m = chat.members.find((x) => x.id === userId);
      if (m) return m;
    }
    return { displayName: 'Участник', color: '#6c8cff' };
  };

  /* --------------------------------------------------------------- рингтон */
  function startRing() {
    if (!K.S.settings.sounds) return;
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

  /* ---------------------------------------------------------------- приглашение */
  function start(chatId, kind) {
    if (C.active) { toast('Вы уже в звонке'); show(); return; }
    ws({ type: 'call:invite', payload: { chatId, kind } });
    toast(kind === 'audio' ? '📞 Создаю аудиозвонок…' : '🎥 Создаю видеозвонок…');
  }

  function showIncoming(payload) {
    C.incoming = payload.call;
    stopRing(); startRing();
    if (K.beep) K.beep('ring');
    $('#incoming').hidden = false;
    const from = userOf(payload.call.from);
    $('#incoming-avatar').outerHTML = avatarHTML(from, 'lg', false, 'incoming-avatar');
    $('#incoming-name').textContent = from.displayName;
    const chat = payload.chat || (K.S.chats.get(payload.call.chatId));
    $('#incoming-sub').textContent = (payload.call.kind === 'audio' ? 'аудиозвонок' : 'видеозвонок') + (chat && chat.type === 'group' ? ' в группе «' + chat.title + '»' : '');
    try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch {}
    if (K.S.settings.notifications && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification('Входящий звонок', { body: from.displayName, icon: '/icon-192.png', tag: 'call' }); } catch {}
    }
  }

  async function accept() {
    const call = C.incoming;
    $('#incoming').hidden = true;
    stopRing();
    if (!call) return;
    ws({ type: 'call:join', payload: { callId: call.id } });
  }

  function decline() {
    const call = C.incoming;
    $('#incoming').hidden = true;
    stopRing();
    C.incoming = null;
    if (call) ws({ type: 'call:decline', payload: { callId: call.id } });
  }

  /* ------------------------------------------------------------- медиа-потоки */
  async function getMedia(kind) {
    const constraints = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
    if (kind === 'video') constraints.video = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      toast('Нет доступа к ' + (kind === 'video' ? 'камере/микрофону' : 'микрофону') + ': ' + err.message + '. Подключаюсь без своего звука.', 'err', 6000);
      try { return await navigator.mediaDevices.getUserMedia({ audio: true }); } catch {}
      return null;
    }
  }

  function createPeer(userId) {
    if (C.peers.has(userId)) return C.peers.get(userId).peer;
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const entry = { pc, stream: null, videoEl: null, tile: null, makingOffer: false };
    C.peers.set(userId, entry);

    if (C.localStream) for (const track of C.localStream.getTracks()) pc.addTrack(track, C.localStream);

    pc.onicecandidate = (e) => {
      if (e.candidate) ws({ type: 'call:signal', payload: { callId: C.call.id, to: userId, data: { candidate: e.candidate } } });
    };
    pc.ontrack = (e) => {
      entry.stream = e.streams[0] || new MediaStream([e.track]);
      attachRemote(userId, entry.stream);
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'failed' || st === 'closed') closePeer(userId);
      renderSubtitle();
    };
    pc.onnegotiationneeded = async () => {
      if (!C.active || entry.makingOffer) return;
      try {
        entry.makingOffer = true;
        await pc.setLocalDescription(await pc.createOffer());
        ws({ type: 'call:signal', payload: { callId: C.call.id, to: userId, data: { sdp: pc.localDescription } } });
      } catch (err) { console.warn(err); } finally { entry.makingOffer = false; }
    };
    return pc;
  }

  async function offerTo(userId) {
    const pc = createPeer(userId);
    try {
      await pc.setLocalDescription(await pc.createOffer());
      ws({ type: 'call:signal', payload: { callId: C.call.id, to: userId, data: { sdp: pc.localDescription } } });
    } catch (err) { console.warn('offer', err); }
  }

  function closePeer(userId) {
    const entry = C.peers.get(userId);
    if (!entry) return;
    try { entry.pc.close(); } catch {}
    C.peers.delete(userId);
    if (entry.tile) entry.tile.remove();
  }

  /* ------------------------------------------------------------------- сетка */
  function makeTile(userId, isLocal) {
    const grid = $('#call-grid');
    const user = isLocal ? K.S.me : userOf(userId);
    const tile = document.createElement('div');
    tile.className = 'call-tile';
    tile.dataset.user = userId;
    tile.innerHTML = `
      <div class="tile-fallback">${avatarHTML(user, 'lg')}<div style="color:#cfd7e8;font-size:14px">${K.esc(user.displayName || 'Участник')}</div></div>
      <video autoplay playsinline ${isLocal ? 'muted' : ''}></video>
      <div class="tile-name">${K.esc((isLocal ? 'Вы' : user.displayName || 'Участник'))}<span class="tile-flags"></span></div>
      <div class="tile-badge" hidden></div>`;
    grid.appendChild(tile);
    const videoEl = tile.querySelector('video');
    const entry = C.peers.get(userId);
    if (entry) { entry.tile = tile; entry.videoEl = videoEl; }
    return { tile, videoEl };
  }

  function attachRemote(userId, stream) {
    const entry = C.peers.get(userId);
    if (!entry) return;
    if (!entry.tile) makeTile(userId, false);
    const videoEl = entry.tile.querySelector('video');
    videoEl.srcObject = stream;
    videoEl.play().catch(() => {});
    renderTiles();
  }

  function renderTiles() {
    const call = C.call;
    if (!call) return;
    const grid = $('#call-grid');
    const ids = [me(), ...call.participants.map((p) => p.userId).filter((id) => id !== me())];
    // убираем плитки ушедших
    for (const tile of [...grid.querySelectorAll('.call-tile')]) {
      const uid = tile.dataset.user;
      if (!ids.includes(uid)) { tile.remove(); C.peers.delete(uid); }
    }
    for (const id of ids) {
      let tile = grid.querySelector(`.call-tile[data-user="${id}"]`);
      const isLocal = id === me();
      const localEntry = isLocal ? null : C.peers.get(id);
      if (!tile) {
        if (isLocal) {
          const made = makeTile(id, true);
          tile = made.tile;
          if (C.localStream) made.videoEl.srcObject = C.localStream;
        } else {
          const made = makeTile(id, false);
          tile = made.tile;
          const entry = C.peers.get(id);
          if (entry) {
            entry.tile = made.tile;
            entry.videoEl = made.videoEl;
            if (entry.stream) made.videoEl.srcObject = entry.stream;
          }
        }
      }
      const p = isLocal ? { camera: C.camOn, muted: C.muted, screen: C.sharing } : (call.participants.find((x) => x.userId === id) || {});
      const videoEl = tile.querySelector('video');
      const showVideo = isLocal ? (C.camOn || C.sharing) : (p.camera !== false || p.screen);
      videoEl.style.display = showVideo ? 'block' : 'none';
      tile.querySelector('.tile-fallback').style.display = showVideo ? 'none' : 'grid';
      const flags = tile.querySelector('.tile-flags');
      if (flags) flags.textContent = (p.muted ? ' 🔇' : '') + (p.screen ? ' 🖥' : '');
      tile.classList.toggle('screen', !!p.screen);
      const badge = tile.querySelector('.tile-badge');
      badge.hidden = !p.screen;
      badge.textContent = 'демонстрация экрана';
      if (p.screen && videoEl.srcObject) videoEl.play().catch(() => {});
    }
    const n = ids.length;
    grid.style.gridTemplateColumns = `repeat(${Math.min(n, n <= 1 ? 1 : n <= 4 ? 2 : 3)}, minmax(260px, 1fr))`;
    renderSubtitle();
  }

  function renderSubtitle() {
    if (!C.call) return;
    const chat = K.S.chats.get(C.call.chatId);
    $('#call-title').textContent = (chat ? chat.title : 'Звонок') + (C.call.kind === 'audio' ? ' · аудио' : ' · видео');
    const secs = C.startedAt ? Math.round((Date.now() - C.startedAt) / 1000) : 0;
    const conns = [...C.peers.values()].map((p) => p.pc.connectionState);
    const bad = conns.filter((s) => s === 'failed' || s === 'disconnected').length;
    $('#call-sub').textContent = `${fmtDur(secs)} · участников: ${C.call.participants.length}${bad ? ' · ⚠️ соединение нестабильно' : ''}`;
  }
  function fmtDur(sec) {
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  /* ------------------------------------------------------------------- эффекты */
  function applyEffect(mode) {
    C.effect = mode;
    const videoTrack = C.camTrack;
    if (!videoTrack) { toast('Эффекты доступны при включённой камере'); return; }
    const filters = {
      none: '',
      blur: 'blur(6px)',
      grayscale: 'grayscale(1)',
      sepia: 'sepia(.75)',
      warm: 'saturate(1.4) hue-rotate(-12deg)',
      cool: 'saturate(1.2) hue-rotate(18deg) brightness(1.05)',
      vintage: 'contrast(1.15) sepia(.35) saturate(1.2)',
    };
    const css = filters[mode] || '';
    const localTile = $(`.call-tile[data-user="${me()}"] video`);
    if (localTile) localTile.style.filter = css;

    // отправляем обработанный поток (canvas capture), чтобы эффект видели все
    const stopProcessor = () => {
      if (C.effectRAF) { cancelAnimationFrame(C.effectRAF); C.effectRAF = null; }
      if (C.effectCanvas) { C.effectCanvas.remove(); C.effectCanvas = null; }
      const senders = [...C.peers.values()].flatMap((p) => p.pc.getSenders().filter((s) => s.track && s.track.kind === 'video'));
      const raw = C.localStream ? C.localStream.getVideoTracks()[0] : null;
      for (const s of senders) { try { s.replaceTrack(raw); } catch {} }
    };
    if (mode === 'none') { stopProcessor(); toast('Эффект выключен'); return; }
    if (!C.effectCanvas) {
      const c = document.createElement('canvas');
      c.style.display = 'none';
      document.body.appendChild(c);
      C.effectCanvas = c;
    }
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.srcObject = new MediaStream([videoTrack]);
    video.play().catch(() => {});
    const canvas = C.effectCanvas;
    const ctx = canvas.getContext('2d');
    const draw = () => {
      if (!C.effectCanvas) return;
      const w = video.videoWidth || 640, h = video.videoHeight || 360;
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      ctx.filter = (filters[C.effect] || 'none').replace('blur(6px)', 'blur(0px)');
      // мягкое «размытие фона»: копия с блюром + резкий овал в центре
      ctx.drawImage(video, 0, 0, w, h);
      if (C.effect === 'blur') {
        ctx.filter = 'none';
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(w / 2, h * .52, w * .24, h * .42, 0, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(video, 0, 0, w, h);
        ctx.restore();
      }
      C.effectRAF = requestAnimationFrame(draw);
    };
    draw();
    const stream = canvas.captureStream(24);
    const procTrack = stream.getVideoTracks()[0];
    for (const entry of C.peers.values()) {
      const sender = entry.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) { try { sender.replaceTrack(procTrack); } catch {} }
    }
    const localVideo = localTile;
    if (localVideo) { localVideo.srcObject = stream; localVideo.style.transform = 'scaleX(-1)'; }
    toast('Эффект: ' + ({ blur: 'размытый фон', grayscale: 'ч/б', sepia: 'сепия', warm: 'тёплый', cool: 'холодный', vintage: 'винтаж' }[mode] || mode));
  }

  /* -------------------------------------------------------------------- запуск */
  async function beginLocal(call) {
    C.call = call;
    C.active = true;
    C.startedAt = Date.now();
    $('#call-screen').hidden = false;
    $('#call-grid').innerHTML = '';
    C.peers.clear();
    renderTiles();

    C.localStream = await getMedia(call.kind);
    if (C.localStream) {
      C.camTrack = C.localStream.getVideoTracks()[0] || null;
      C.camOn = !!C.camTrack && C.camTrack.enabled;
      C.muted = !C.localStream.getAudioTracks().length;
      for (const track of C.localStream.getTracks()) {
        for (const entry of C.peers.values()) entry.pc.addTrack(track, C.localStream);
      }
    }
    renderTiles();
    ws({ type: 'call:state', payload: { callId: call.id, state: { muted: C.muted, camera: C.camOn } } });
    clearInterval(C.timer);
    C.timer = setInterval(renderSubtitle, 1000);
    renderSubtitle();
  }

  async function onJoined(payload) {
    const { call, existingPeers = [] } = payload;
    await beginLocal(call);
    for (const peerId of existingPeers) {
      if (peerId === me()) continue;
      createPeer(peerId);
      if (me() > peerId) await offerTo(peerId);   // оффер делает «старший» id — иначе двойные офферы
    }
    renderTiles();
  }

  async function onPeerJoined(payload) {
    if (!C.call) return;
    C.call = payload.call || C.call;
    const peerId = payload.userId;
    if (peerId === me()) return;
    createPeer(peerId);
    if (me() > peerId) await offerTo(peerId);
    renderTiles();
    toast(userOf(peerId).displayName + ' присоединился(ась) к звонку', 'ok');
  }

  async function onSignal(payload) {
    if (!C.call || payload.callId !== C.call.id) return;
    const from = payload.from;
    const data = payload.data || {};
    const pc = createPeer(from);
    const entry = C.peers.get(from);
    try {
      if (data.sdp) {
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          ws({ type: 'call:signal', payload: { callId: C.call.id, to: from, data: { sdp: pc.localDescription } } });
        }
      } else if (data.candidate) {
        try { await pc.addIceCandidate(data.candidate); } catch (err) { console.warn('ice', err.message); }
      } else if (data.bye) {
        closePeer(from);
        renderTiles();
      }
    } catch (err) { console.warn('signal', err); }
  }

  function hangup() {
    if (!C.call) return teardown();
    ws({ type: 'call:leave', payload: { callId: C.call.id } });
    teardown();
  }

  function teardown() {
    if (C.call) for (const [uid] of C.peers) ws({ type: 'call:signal', payload: { callId: C.call.id, to: uid, data: { bye: true } } });
    stopRing();
    for (const [uid] of [...C.peers]) closePeer(uid);
    if (C.effectRAF) cancelAnimationFrame(C.effectRAF);
    if (C.effectCanvas) C.effectCanvas.remove();
    if (C.localStream) for (const t of C.localStream.getTracks()) t.stop();
    if (C.screenStream) for (const t of C.screenStream.getTracks()) t.stop();
    C.localStream = null; C.screenStream = null; C.camTrack = null;
    C.effectCanvas = null; C.effectRAF = null; C.effect = 'none';
    C.active = false; C.call = null; C.camOn = false; C.muted = false; C.sharing = false;
    clearInterval(C.timer);
    $('#call-grid').innerHTML = '';
    $('#call-screen').hidden = true;
    $('#ctl-cam').classList.remove('off', 'active');
    $('#ctl-mic').classList.remove('off');
    $('#ctl-screen').classList.remove('active');
    hideMini();
    if (K.renderChats) K.renderChats();
  }

  /* ------------------------------------------------------------------ элементы управления */
  function toggleMic() {
    if (!C.localStream) return;
    const tracks = C.localStream.getAudioTracks();
    if (!tracks.length) { toast('Микрофон недоступен', 'err'); return; }
    C.muted = !C.muted;
    for (const t of tracks) t.enabled = !C.muted;
    $('#ctl-mic').classList.toggle('off', C.muted);
    ws({ type: 'call:state', payload: { callId: C.call.id, state: { muted: C.muted } } });
    renderTiles();
  }

  function toggleCam() {
    if (!C.localStream) return;
    const tracks = C.localStream.getVideoTracks();
    if (!tracks.length) { toast('Камера недоступна'); return; }
    C.camOn = !C.camOn;
    for (const t of tracks) t.enabled = C.camOn;
    $('#ctl-cam').classList.toggle('off', !C.camOn);
    ws({ type: 'call:state', payload: { callId: C.call.id, state: { camera: C.camOn } } });
    renderTiles();
    if (C.camTrack && C.effect !== 'none' && C.camOn) applyEffect(C.effect);
  }

  async function toggleScreen() {
    if (!C.call) return;
    if (C.sharing) { stopScreen(); return; }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
      C.screenStream = stream;
      C.sharing = true;
      const track = stream.getVideoTracks()[0];
      for (const entry of C.peers.values()) {
        const sender = entry.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
        if (sender) { try { await sender.replaceTrack(track); } catch {} }
        else if (C.localStream) { try { entry.pc.addTrack(track, stream); } catch {} }
      }
      const localVideo = $(`.call-tile[data-user="${me()}"] video`);
      if (localVideo) { localVideo.srcObject = stream; localVideo.style.transform = 'none'; }
      $('#ctl-screen').classList.add('active');
      ws({ type: 'call:state', payload: { callId: C.call.id, state: { screen: true } } });
      track.onended = stopScreen;
      toast('Демонстрация экрана началась 🖥');
      renderTiles();
    } catch (err) { toast('Не удалось начать демонстрацию: ' + err.message, 'err'); }
  }

  async function stopScreen() {
    if (!C.sharing) return;
    C.sharing = false;
    if (C.screenStream) for (const t of C.screenStream.getTracks()) t.stop();
    C.screenStream = null;
    const camTrack = C.localStream ? C.localStream.getVideoTracks()[0] : null;
    for (const entry of C.peers.values()) {
      const sender = entry.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender && camTrack) { try { await sender.replaceTrack(camTrack); } catch {} }
    }
    const localVideo = $(`.call-tile[data-user="${me()}"] video`);
    if (localVideo && C.localStream) { localVideo.srcObject = C.localStream; localVideo.style.transform = 'scaleX(-1)'; }
    $('#ctl-screen').classList.remove('active');
    if (C.call) ws({ type: 'call:state', payload: { callId: C.call.id, state: { screen: false } } });
    renderTiles();
  }

  function cycleEffect() {
    const modes = ['none', 'blur', 'warm', 'cool', 'grayscale', 'sepia', 'vintage'];
    const next = modes[(modes.indexOf(C.effect) + 1) % modes.length];
    applyEffect(next);
  }

  /* ------------------------------------------------------------------ минимизация */
  function minimize() {
    $('#call-screen').hidden = true;
    showMini();
  }
  function showMini() {
    hideMini();
    const bar = document.createElement('div');
    bar.className = 'call-mini';
    bar.id = 'call-mini-bar';
    bar.textContent = '🎥 Вернуться к звонку';
    bar.onclick = show;
    document.body.appendChild(bar);
    C.mini = bar;
  }
  function hideMini() { if (C.mini) { C.mini.remove(); C.mini = null; } }
  function show() { hideMini(); $('#call-screen').hidden = false; }

  /* ---------------------------------------------------------------------- события */
  function onEvent(type, p) {
    switch (type) {
      case 'call:incoming': showIncoming(p); break;
      case 'call:started': onJoined({ call: p.call, existingPeers: p.existingPeers || [p.call.participants.map((x) => x.userId)].flat() }); break;
      case 'call:joined': onJoined(p); break;
      case 'call:peer-joined': onPeerJoined(p); break;
      case 'call:peer-left': {
        if (!C.call || p.callId !== C.call.id) break;
        C.call = p.call || C.call;
        if (p.userId !== me()) { closePeer(p.userId); renderTiles(); toast(userOf(p.userId).displayName + ' вышел(ла) из звонка'); }
        break;
      }
      case 'call:peer-declined': {
        if (p.userId !== me()) toast(userOf(p.userId).displayName + ' отклонил(а) звонок');
        break;
      }
      case 'call:ended': {
        toast('Звонок завершён');
        if (C.call && C.call.id === p.callId) teardown();
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
    }
  }

  function bind() {
    $('#btn-accept').addEventListener('click', accept);
    $('#btn-decline').addEventListener('click', decline);
    $('#ctl-mic').addEventListener('click', toggleMic);
    $('#ctl-cam').addEventListener('click', toggleCam);
    $('#ctl-screen').addEventListener('click', toggleScreen);
    $('#ctl-effects').addEventListener('click', cycleEffect);
    $('#ctl-hangup').addEventListener('click', hangup);
    $('#btn-call-minimize').addEventListener('click', minimize);
    window.addEventListener('beforeunload', () => { if (C.call) ws({ type: 'call:leave', payload: { callId: C.call.id } }); });
  }

  window.K = K;
  window.K.calls = { start, onEvent, accept, decline, hangup, teardown, toggleMic, toggleCam, toggleScreen, cycleEffect, minimize, show, state: C, bind };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
