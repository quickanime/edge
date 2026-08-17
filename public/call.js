/**
 * Sesli / goruntulu gorusme ve ekran paylasimi (WebRTC).
 *
 * Medya tarayicilar arasinda dogrudan akar ve WebRTC geregi DTLS-SRTP ile
 * sifrelenir; sunucu yalnizca teklif/yanit paketlerini tasir, onlar da
 * kullanicilarin anahtarlariyla ayrica sifrelenir.
 *
 * Baglanti kurulumu "trickle" yerine tek pakette yapilir: ICE toplama bitince
 * teklif tek seferde gonderilir. Boylece yoklamaya dayali sinyallesme ile de
 * gorusme hizli kurulur.
 */

import { api, setUrgent } from './net.js';
import * as E2E from './crypto.js';
import { h, icon, ICONS, avatarNode, initials } from './dom.js';

const ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' }
];

export const QUALITY = {
  auto: { label: 'Otomatik', width: 1280, height: 720, fps: 30, bitrate: 1_600_000 },
  hd: { label: '720p', width: 1280, height: 720, fps: 30, bitrate: 1_600_000 },
  fhd: { label: '1080p', width: 1920, height: 1080, fps: 30, bitrate: 4_000_000 },
  uhd: { label: '4K', width: 3840, height: 2160, fps: 30, bitrate: 14_000_000 }
};

const state = {
  active: false,
  roomId: null,
  kind: 'audio',
  title: '',
  target: null,          // { conversationId } veya { meetingId }
  me: null,
  peers: new Map(),      // userId -> { pc, nick, avatar, publicKey, stream, tile }
  localStream: null,
  screenStream: null,
  micOn: true,
  camOn: true,
  sharing: false,
  quality: 'fhd',
  startedAt: 0,
  ring: null,            // gelen cagri
  autoEndWhenEmpty: true, // birebir gorusmede karsi taraf cikinca kapat
  hadPeers: false
};

let ringHandler = () => {};
let root = null;
let timerId = null;

export const isActive = () => state.active;
export const currentRoom = () => state.roomId;
export function onRing(fn) { ringHandler = fn; }

export function setMe(user) { state.me = user; }

/* ------------------------------------------------------------------ */
/* medya                                                               */
/* ------------------------------------------------------------------ */

function videoConstraints(quality) {
  const q = QUALITY[quality] || QUALITY.fhd;
  return {
    width: { ideal: q.width, max: q.width },
    height: { ideal: q.height, max: q.height },
    frameRate: { ideal: q.fps, max: 60 }
  };
}

async function getLocalStream(kind, quality) {
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  if (kind !== 'video') return navigator.mediaDevices.getUserMedia({ audio });
  try {
    return await navigator.mediaDevices.getUserMedia({ audio, video: videoConstraints(quality) });
  } catch {
    // Istenen cozunurluk desteklenmiyorsa kamerayi varsayilan ayarla ac.
    return navigator.mediaDevices.getUserMedia({ audio, video: true });
  }
}

async function tuneSender(sender, { screen = false } = {}) {
  if (!sender || sender.track.kind !== 'video') return;
  const q = QUALITY[state.quality] || QUALITY.fhd;
  const params = sender.getParameters();
  params.encodings = params.encodings && params.encodings.length ? params.encodings : [{}];
  params.encodings[0].maxBitrate = screen ? Math.max(q.bitrate, 8_000_000) : q.bitrate;
  params.encodings[0].maxFramerate = screen ? 30 : q.fps;
  params.encodings[0].scaleResolutionDownBy = 1;
  params.degradationPreference = screen ? 'maintain-resolution' : 'maintain-framerate';
  try { await sender.setParameters(params); } catch { /* tarayici desteklemiyorsa gec */ }
  sender.track.contentHint = screen ? 'detail' : 'motion';
}

/* ------------------------------------------------------------------ */
/* eslesme                                                             */
/* ------------------------------------------------------------------ */

function peerRecord(user) {
  let record = state.peers.get(user.id);
  if (!record) {
    record = { nick: user.nick, avatar: user.avatar || null, publicKey: user.publicKey, pc: null, stream: null };
    state.peers.set(user.id, record);
    state.hadPeers = true;
  } else {
    record.nick = user.nick || record.nick;
    record.publicKey = user.publicKey || record.publicKey;
    record.avatar = user.avatar || record.avatar;
  }
  return record;
}

function newPeerConnection(userId) {
  const pc = new RTCPeerConnection({ iceServers: ICE, bundlePolicy: 'max-bundle' });

  for (const track of state.localStream.getTracks()) {
    const sender = pc.addTrack(track, state.localStream);
    tuneSender(sender, { screen: state.sharing && track.kind === 'video' });
  }

  pc.addEventListener('track', (event) => {
    const record = state.peers.get(userId);
    if (!record) return;
    record.stream = event.streams[0];
    renderOverlay();
  });

  pc.addEventListener('connectionstatechange', () => {
    if (['failed', 'closed'].includes(pc.connectionState)) dropPeer(userId);
    else renderOverlay();
  });

  return pc;
}

function waitForIce(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timeout); resolve(); };
    const timeout = setTimeout(done, 3000);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') done();
    });
  });
}

async function sendSignal(userId, type, description) {
  const record = state.peers.get(userId);
  if (!record) return;
  const payload = await E2E.sealFor(record.publicKey, JSON.stringify(description));
  await api.post('/api/calls/signal', {
    roomId: state.roomId, toUserId: userId, signal: { type }, payload
  });
}

async function offerTo(user) {
  const record = peerRecord(user);
  if (record.pc) return;
  record.pc = newPeerConnection(user.id);
  const offer = await record.pc.createOffer();
  await record.pc.setLocalDescription(offer);
  await waitForIce(record.pc);
  await sendSignal(user.id, 'offer', record.pc.localDescription);
  renderOverlay();
}

async function onOffer(fromUser, description) {
  const record = peerRecord(fromUser);
  if (!record.pc) record.pc = newPeerConnection(fromUser.id);
  await record.pc.setRemoteDescription(description);
  const answer = await record.pc.createAnswer();
  await record.pc.setLocalDescription(answer);
  await waitForIce(record.pc);
  await sendSignal(fromUser.id, 'answer', record.pc.localDescription);
  renderOverlay();
}

async function onAnswer(fromUser, description) {
  const record = state.peers.get(fromUser.id);
  if (!record || !record.pc) return;
  if (record.pc.signalingState === 'stable') return;
  await record.pc.setRemoteDescription(description);
  renderOverlay();
}

function dropPeer(userId) {
  const record = state.peers.get(userId);
  if (!record) return;
  if (record.pc) { try { record.pc.close(); } catch { /* kapaliysa gec */ } }
  state.peers.delete(userId);

  if (!state.active) return;
  if (state.peers.size === 0 && state.hadPeers) {
    if (state.autoEndWhenEmpty) {
      // Birebir gorusme: karsi taraf ayrildi, gorusmeyi kapat.
      renderOverlay('Karsi taraf gorusmeden ayrildi');
      setTimeout(() => { if (state.active && state.peers.size === 0) endCall(); }, 1200);
      return;
    }
    renderOverlay('Diger katilimcilar ayrildi');
    return;
  }
  renderOverlay();
}

/* ------------------------------------------------------------------ */
/* gorusme yasam dongusu                                               */
/* ------------------------------------------------------------------ */

export async function startCall({ target, kind = 'audio', title = '', quality = 'fhd', multi = false }) {
  if (state.active) throw new Error('Zaten bir gorusmedesin.');
  state.quality = quality;
  state.autoEndWhenEmpty = !multi;
  state.hadPeers = false;
  state.localStream = await getLocalStream(kind, quality);
  state.kind = kind;
  state.title = title;
  state.target = target;
  state.micOn = true;
  state.camOn = kind === 'video';
  state.sharing = false;
  state.startedAt = Date.now();

  const res = await api.post('/api/calls/start', { ...target, kind });
  state.roomId = res.room.roomId;
  state.active = true;
  setUrgent(true);
  showOverlay();
  return res.room;
}

export async function acceptCall({ target, roomId, kind, title, quality = 'fhd', multi = false }) {
  if (state.active) endCall();
  state.quality = quality;
  state.autoEndWhenEmpty = !multi;
  state.hadPeers = false;
  state.localStream = await getLocalStream(kind, quality);
  state.kind = kind;
  state.title = title || '';
  state.target = target;
  state.roomId = roomId;
  state.micOn = true;
  state.camOn = kind === 'video';
  state.sharing = false;
  state.startedAt = Date.now();
  state.active = true;
  state.ring = null;
  setUrgent(true);

  const res = await api.post('/api/calls/join', { ...target, kind });
  for (const peer of res.peers) peerRecord(peer);
  showOverlay();
  return res;
}

export function declineCall() {
  const ring = state.ring;
  state.ring = null;
  ringHandler(null);
  if (ring) api.post('/api/calls/decline', ring.target).catch(() => {});
}

export function endCall() {
  const target = state.target;
  for (const [userId] of state.peers) dropPeer(userId);
  if (state.localStream) state.localStream.getTracks().forEach((t) => t.stop());
  if (state.screenStream) state.screenStream.getTracks().forEach((t) => t.stop());

  state.active = false;
  state.peers.clear();
  state.localStream = null;
  state.screenStream = null;
  state.sharing = false;
  state.roomId = null;
  setUrgent(false);
  hideOverlay();

  if (target) api.post('/api/calls/leave', target).catch(() => {});
}

export function toggleMic() {
  state.micOn = !state.micOn;
  for (const track of state.localStream ? state.localStream.getAudioTracks() : []) {
    track.enabled = state.micOn;
  }
  renderOverlay();
}

export function toggleCam() {
  const tracks = state.localStream ? state.localStream.getVideoTracks() : [];
  if (!tracks.length) return;
  state.camOn = !state.camOn;
  for (const track of tracks) track.enabled = state.camOn;
  renderOverlay();
}

/** Ekran paylasimi: video izini tum eslere degistir, birakinca kameraya don. */
export async function toggleScreenShare() {
  if (state.sharing) return stopScreenShare();
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: { ideal: 30, max: 60 },
      width: { ideal: 3840 }, height: { ideal: 2160 }
    },
    audio: true
  });
  state.screenStream = stream;
  state.sharing = true;
  const screenTrack = stream.getVideoTracks()[0];
  screenTrack.addEventListener('ended', () => stopScreenShare());

  for (const [, record] of state.peers) {
    if (!record.pc) continue;
    const sender = record.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender) { await sender.replaceTrack(screenTrack); await tuneSender(sender, { screen: true }); }
    else { const added = record.pc.addTrack(screenTrack, stream); await tuneSender(added, { screen: true }); }
  }
  renderOverlay();
}

export async function stopScreenShare() {
  if (!state.sharing) return;
  state.sharing = false;
  if (state.screenStream) state.screenStream.getTracks().forEach((t) => t.stop());
  state.screenStream = null;

  const cameraTrack = state.localStream ? state.localStream.getVideoTracks()[0] : null;
  for (const [, record] of state.peers) {
    if (!record.pc) continue;
    const sender = record.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender && cameraTrack) { await sender.replaceTrack(cameraTrack); await tuneSender(sender); }
  }
  renderOverlay();
}

export async function setQuality(quality) {
  state.quality = quality;
  if (state.kind !== 'video' || !state.localStream) return renderOverlay();
  const next = await getLocalStream('video', quality);
  const newTrack = next.getVideoTracks()[0];
  const old = state.localStream.getVideoTracks()[0];

  if (!state.sharing) {
    for (const [, record] of state.peers) {
      if (!record.pc) continue;
      const sender = record.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) { await sender.replaceTrack(newTrack); await tuneSender(sender); }
    }
  }
  if (old) { state.localStream.removeTrack(old); old.stop(); }
  state.localStream.addTrack(newTrack);
  for (const track of next.getAudioTracks()) track.stop();
  renderOverlay();
}

/* ------------------------------------------------------------------ */
/* olaylar                                                             */
/* ------------------------------------------------------------------ */

export async function handleEvent(event, lookupUser) {
  switch (event.type) {
    case 'call:ring': {
      if (state.active && state.roomId === event.roomId) return;
      state.ring = {
        roomId: event.roomId, kind: event.kind, fromNick: event.fromNick,
        fromUserId: event.fromUserId, title: event.title,
        target: event.meetingId ? { meetingId: event.meetingId } : { conversationId: event.conversationId }
      };
      ringHandler(state.ring);
      break;
    }
    case 'call:joined': {
      if (!state.active || event.roomId !== state.roomId) return;
      const user = await lookupUser(event.userId);
      if (user) await offerTo(user);
      break;
    }
    case 'call:signal': {
      if (!state.active || event.roomId !== state.roomId) return;
      const user = await lookupUser(event.fromUserId);
      if (!user) return;
      const record = peerRecord(user);
      const description = JSON.parse(await E2E.openFrom(record.publicKey, event.payload));
      if (event.signal.type === 'offer') await onOffer(user, description);
      else if (event.signal.type === 'answer') await onAnswer(user, description);
      break;
    }
    case 'call:state': {
      if (event.state === 'declined' && state.active && event.roomId === state.roomId) {
        renderOverlay(`${event.nick || 'Karsi taraf'} gorusmeyi reddetti`);
      }
      if (event.state === 'left') dropPeer(event.userId);
      if (state.ring && state.ring.roomId === event.roomId && event.state === 'left') {
        state.ring = null;
        ringHandler(null);
      }
      break;
    }
  }
}

/* ------------------------------------------------------------------ */
/* gorusme ekrani                                                      */
/* ------------------------------------------------------------------ */

function showOverlay() {
  if (!root) {
    root = h('div', { class: 'call-layer', id: 'call-layer' });
    document.body.append(root);
  }
  root.classList.remove('is-hidden');
  clearInterval(timerId);
  timerId = setInterval(() => {
    const el = document.getElementById('call-timer');
    if (el) el.textContent = elapsed();
  }, 1000);
  renderOverlay();
}

function hideOverlay() {
  clearInterval(timerId);
  if (!root) return;
  root.replaceChildren();
  root.classList.add('is-hidden');
}

function elapsed() {
  const total = Math.floor((Date.now() - state.startedAt) / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function videoTile(stream, label, { muted = false, avatar = null, sub = '' } = {}) {
  const tile = h('div', { class: 'tile' });
  const hasVideo = stream && stream.getVideoTracks().some((t) => t.enabled && t.readyState === 'live');

  if (hasVideo) {
    const video = h('video', { autoplay: true, playsinline: true, muted });
    video.srcObject = stream;
    tile.append(video);
  } else {
    tile.append(h('div', { class: 'tile-avatar' }, [
      avatar ? h('img', { src: avatar, alt: '' }) : h('span', { text: initials(label) })
    ]));
  }
  tile.append(h('div', { class: 'tile-label' }, [
    h('span', { text: label }),
    sub ? h('small', { text: sub }) : null
  ]));
  return tile;
}

export function renderOverlay(notice = '') {
  if (!root || !state.active) return;

  const tiles = h('div', { class: `tiles count-${Math.min(state.peers.size + 1, 6)}` }, [
    videoTile(state.localStream, 'Sen', {
      muted: true,
      avatar: state.me && state.me.avatar,
      sub: [!state.micOn ? 'mikrofon kapali' : '', state.sharing ? 'ekran paylasiyor' : ''].filter(Boolean).join(' · ')
    }),
    ...[...state.peers.entries()].map(([userId, record]) => videoTile(record.stream, record.nick, {
      avatar: record.avatar,
      sub: record.pc && record.pc.connectionState === 'connected' ? '' : 'baglaniyor...'
    }))
  ]);

  const controls = h('div', { class: 'call-controls' }, [
    h('button', {
      class: `call-btn${state.micOn ? '' : ' is-off'}`, title: 'Mikrofon', onClick: toggleMic
    }, [icon(state.micOn ? ICONS.mic : ICONS.micOff, 20)]),
    state.kind === 'video' ? h('button', {
      class: `call-btn${state.camOn ? '' : ' is-off'}`, title: 'Kamera', onClick: toggleCam
    }, [icon(state.camOn ? ICONS.cam : ICONS.camOff, 20)]) : null,
    h('button', {
      class: `call-btn${state.sharing ? ' is-on' : ''}`, title: 'Ekran paylas',
      onClick: () => toggleScreenShare().catch((err) => renderOverlay(err.message))
    }, [icon(ICONS.screen, 20)]),
    h('select', {
      class: 'call-quality', title: 'Goruntu kalitesi',
      onChange: (e) => setQuality(e.target.value).catch(() => {})
    }, Object.entries(QUALITY).filter(([key]) => key !== 'auto').map(([key, q]) =>
      h('option', { value: key, text: q.label, selected: state.quality === key }))),
    h('button', { class: 'call-btn is-end', title: 'Gorusmeyi bitir', onClick: endCall },
      [icon(ICONS.hangup, 20)])
  ]);

  root.replaceChildren(h('div', { class: 'call-shell' }, [
    h('header', { class: 'call-head' }, [
      h('div', { class: 'grow' }, [
        h('strong', { text: state.title || (state.kind === 'video' ? 'Goruntulu gorusme' : 'Sesli gorusme') }),
        h('div', { class: 'muted' }, [
          h('span', { id: 'call-timer', text: elapsed() }),
          h('span', { text: ` · ${state.peers.size + 1} kisi · uctan uca sifreli` })
        ])
      ]),
      notice ? h('span', { class: 'pill pill-warn', text: notice }) : null
    ]),
    tiles,
    controls
  ]));
}
