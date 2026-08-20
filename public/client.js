'use strict';

/* ===========================================================
   島の開拓者たち — クライアント
   =========================================================== */

const RES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
const RES_JA = { wood: '木材', brick: 'レンガ', sheep: '羊毛', wheat: '小麦', ore: '鉱石' };
const RES_ICON = { wood: '🌲', brick: '🧱', sheep: '🐑', wheat: '🌾', ore: '⛰️' };
const DEV_JA = { knight: '騎士', road: '街道建設', plenty: '発見', monopoly: '独占' };
const DEV_DESC = {
  knight: '盗賊を動かし、資源を1枚奪う。3枚使用で最大騎士力（2点）。',
  road: '街道を2本まで無料で建設する。',
  plenty: '好きな資源を2枚、銀行から受け取る。',
  monopoly: '資源を1種類指定し、全員の手札から集める。',
};
const COST_TEXT = {
  road: '🌲🧱', settlement: '🌲🧱🐑🌾', city: '⛰️⛰️⛰️🌾🌾', dev: '🐑🌾⛰️',
};

const $ = s => document.querySelector(s);
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h !== undefined) e.innerHTML = h; return e; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const S = {
  playerId: localStorage.getItem('pid') || (() => {
    const v = 'p' + Math.random().toString(36).slice(2, 12);
    localStorage.setItem('pid', v); return v;
  })(),
  name: localStorage.getItem('pname') || '',
  code: null, room: null, state: null, board: null,
  mode: null, modal: null, ms: {}, lastTurnKey: '',
};

const socket = io();

/* ---------------- 画面遷移 ---------------- */
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 3200);
}

/* ---------------- ホーム ---------------- */
$('#home-name-a').value = S.name;
$('#home-name-b').value = S.name;

$('#btn-create').onclick = () => {
  const name = $('#home-name-a').value.trim();
  if (!name) return toast('名前を入力してください');
  localStorage.setItem('pname', name); S.name = name;
  socket.emit('createRoom', { name, playerId: S.playerId });
};
$('#btn-join').onclick = () => {
  const name = $('#home-name-b').value.trim();
  const code = $('#home-code').value.trim().toUpperCase();
  if (!name) return toast('名前を入力してください');
  if (code.length !== 4) return toast('合言葉は4文字です');
  localStorage.setItem('pname', name); S.name = name;
  socket.emit('joinRoom', { code, name, playerId: S.playerId });
};
$('#home-code').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase(); });
$('#btn-copy').onclick = async () => {
  try { await navigator.clipboard.writeText(S.code); toast('合言葉をコピーしました'); }
  catch { toast('コピーできませんでした'); }
};
$('#btn-leave').onclick = () => {
  localStorage.removeItem('room');
  S.code = null; S.room = null; S.state = null; S.board = null;
  socket.disconnect(); socket.connect();
  show('screen-home');
};

/* ---------------- 通信 ---------------- */
socket.on('connect', () => {
  const saved = localStorage.getItem('room');
  if (saved && S.name) socket.emit('joinRoom', { code: saved, name: S.name, playerId: S.playerId });
});
socket.on('errorMsg', m => toast(m));
socket.on('kicked', () => { localStorage.removeItem('room'); show('screen-home'); toast('部屋から退出しました'); });
socket.on('joined', ({ code }) => { S.code = code; localStorage.setItem('room', code); });
socket.on('board', b => { S.board = b; renderBoard(); });
socket.on('room', r => {
  S.room = r;
  if (!r.started) { S.state = null; show('screen-lobby'); renderLobby(); }
});
socket.on('state', st => {
  const prev = S.state;
  S.state = st;
  if (!S.board) socket.emit('requestBoard');
  show('screen-game');
  if (prev && prev.phase !== 'ended' && st.phase === 'ended') S.modal = { type: 'gameover' };
  notifyTurn(prev, st);
  renderAll();
});

/* ---------------- ロビー ---------------- */
const OPTION_DEFS = [
  { key: 'maxPlayers', label: '最大人数', type: 'seg', values: [3, 4, 5, 6], suffix: '人' },
  { key: 'victoryPoints', label: '勝利点', type: 'seg', values: [8, 10, 12, 14], suffix: '点' },
  { key: 'bigBoard', label: '拡張ボード（30マス）', type: 'bool' },
  { key: 'specialBuild', label: '特別建設フェイズ', type: 'bool', note: '5〜6人戦のみ有効。他人の手番終了後に建設できます。' },
  { key: 'balancedNumbers', label: '6と8を隣接させない', type: 'bool' },
  { key: 'friendlyRobber', label: '弱者を守る盗賊', type: 'bool', note: '2点以下のプレイヤーからは奪えません。' },
  { key: 'noRobberFirstTurns', label: '最初の1周は7を振り直す', type: 'bool' },
  { key: 'discardLimit', label: '7で捨て始める手札', type: 'seg', values: [7, 9, 11], suffix: '枚' },
];

function renderLobby() {
  const r = S.room;
  if (!r) return;
  const isHost = r.hostId === S.playerId;
  $('#lobby-code').textContent = r.code;
  $('#lobby-count').textContent = `${r.players.length} / ${r.opts.maxPlayers}`;

  const ul = $('#lobby-players'); ul.innerHTML = '';
  r.players.forEach(p => {
    const li = el('li', p.connected ? '' : 'off');
    li.append(el('span', 'dot'));
    li.lastChild.style.background = p.color;
    li.append(el('span', 'pname', esc(p.name)));
    if (p.id === r.hostId) li.append(el('span', 'tag', '部屋主'));
    if (!p.connected) li.append(el('span', 'tag', '切断中'));
    if (isHost && p.id !== S.playerId) {
      const b = el('button', 'ghost small', '退出');
      b.onclick = () => socket.emit('kick', { playerId: p.id });
      li.append(b);
    }
    ul.append(li);
  });

  $('#lobby-wait').textContent = isHost
    ? '全員そろったら開始してください。'
    : '部屋主が開始するまでお待ちください。';

  const box = $('#lobby-options'); box.innerHTML = '';
  OPTION_DEFS.forEach(def => {
    const row = el('div', 'opt-row');
    row.append(el('span', '', esc(def.label)));
    const seg = el('div', 'seg');
    if (def.type === 'bool') {
      [['on', true], ['off', false]].forEach(([lab, val]) => {
        const b = el('button', r.opts[def.key] === val ? 'on' : '', val ? 'あり' : 'なし');
        b.disabled = !isHost;
        b.onclick = () => socket.emit('setOptions', { opts: { [def.key]: val } });
        seg.append(b);
      });
    } else {
      def.values.forEach(v => {
        const b = el('button', r.opts[def.key] === v ? 'on' : '', v + (def.suffix || ''));
        b.disabled = !isHost;
        b.onclick = () => socket.emit('setOptions', { opts: { [def.key]: v } });
        seg.append(b);
      });
    }
    row.append(seg); box.append(row);
    if (def.note) box.append(el('p', 'opt-note', esc(def.note)));
  });

  const start = $('#btn-start');
  start.disabled = !isHost || r.players.length < 2;
  start.textContent = isHost ? `ゲームを始める（${r.players.length}人）` : '部屋主の開始を待っています';
  start.onclick = () => socket.emit('startGame');
}

/* ---------------- 手番通知 ---------------- */
let audioCtx;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'sine'; o.frequency.value = 660;
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.12, audioCtx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.45);
    o.connect(g).connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + 0.5);
  } catch { /* 音が出せない環境では無視 */ }
}
function notifyTurn(prev, st) {
  const key = `${st.phase}|${actorIndex(st)}|${st.turn.step}`;
  const mine = actorIndex(st) === st.me || st.turn.myDiscard > 0;
  if (mine && key !== S.lastTurnKey) { beep(); document.title = '● あなたの番 — 島の開拓者たち'; }
  if (!mine) document.title = '島の開拓者たち';
  S.lastTurnKey = key;
}

/* ---------------- 状態ヘルパ ---------------- */
function actorIndex(st) { const t = st.turn; return t.step === 'special' ? t.special : t.p; }
function me() { return S.state.players[S.state.me]; }
function isMyTurn() { return actorIndex(S.state) === S.state.me; }
function canBuildNow() { const s = S.state.turn.step; return isMyTurn() && (s === 'main' || s === 'special'); }
function afford(cost) {
  const r = me().res;
  return Object.entries(cost).every(([k, v]) => r[k] >= v);
}
const COSTS = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city: { ore: 3, wheat: 2 },
  dev: { sheep: 1, wheat: 1, ore: 1 },
};

function effectiveMode() {
  const st = S.state, t = st.turn;
  if (!isMyTurn()) return null;
  if (st.phase === 'setup') return t.step === 'setupSettlement' ? 'settlement' : 'road';
  if (t.step === 'robber') return 'robber';
  if (t.freeRoads > 0) return 'road';
  return S.mode;
}
const act = a => socket.emit('action', a);

/* ---------------- 全体描画 ---------------- */
function renderAll() {
  renderBoard();
  renderPlayers();
  renderLog();
  renderHand();
  renderActions();
  renderBanner();
  syncModal();
}

/* ---------------- 盤面 ---------------- */
function hexPoints(b, h) {
  return h.vertices.map(v => `${b.vertices[v].x},${b.vertices[v].y}`).join(' ');
}
function pipsFor(n) { return '•'.repeat(6 - Math.abs(7 - n)); }

function renderBoard() {
  const b = S.board, st = S.state;
  if (!b || !st) return;
  const vs = Object.values(b.vertices);
  const minX = Math.min(...vs.map(v => v.x)) - 105, maxX = Math.max(...vs.map(v => v.x)) + 105;
  const minY = Math.min(...vs.map(v => v.y)) - 105, maxY = Math.max(...vs.map(v => v.y)) + 105;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const rad = Math.hypot(maxX - minX, maxY - minY) / 2;
  const mode = effectiveMode();
  const valid = st.valid || { settlements: [], roads: [], cities: [], robberHexes: [] };
  const P = [];

  P.push(`<svg viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}" preserveAspectRatio="xMidYMid meet">`);
  P.push(`<defs><radialGradient id="seaG" cx="50%" cy="45%"><stop offset="0%" stop-color="#175a70"/><stop offset="100%" stop-color="#0a2531"/></radialGradient></defs>`);
  P.push(`<rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" fill="url(#seaG)"/>`);

  /* 海図のラムライン（風配図） */
  P.push('<g class="sea-rose">');
  for (let i = 0; i < 16; i++) {
    const a = i * Math.PI / 8;
    P.push(`<line x1="${cx}" y1="${cy}" x2="${cx + Math.cos(a) * rad}" y2="${cy + Math.sin(a) * rad}" stroke="#1c5063" stroke-width="1"/>`);
  }
  P.push(`<circle cx="${cx}" cy="${cy}" r="${rad * 0.62}" stroke="#1c5063" stroke-width="1"/>`);
  P.push(`<circle cx="${cx}" cy="${cy}" r="${rad * 0.86}" stroke="#1c5063" stroke-width="1"/>`);
  P.push('</g>');

  /* 港 */
  b.ports.forEach(p => {
    p.vertices.forEach(v => {
      P.push(`<line class="port-line" x1="${p.x}" y1="${p.y}" x2="${b.vertices[v].x}" y2="${b.vertices[v].y}"/>`);
    });
    P.push(`<g><circle class="port-plaque" cx="${p.x}" cy="${p.y}" r="31"/>`);
    if (p.type === 'any') {
      P.push(`<text class="port-t" x="${p.x}" y="${p.y + 7}">3:1</text>`);
    } else {
      P.push(`<text x="${p.x}" y="${p.y - 2}" font-size="22" text-anchor="middle">${RES_ICON[p.type]}</text>`);
      P.push(`<text class="port-t" x="${p.x}" y="${p.y + 20}" font-size="15">2:1</text>`);
    }
    P.push('</g>');
  });

  /* 地形 */
  b.hexes.forEach(h => {
    const blocked = st.robber === h.id;
    P.push(`<polygon class="hex hex-${h.terrain}${blocked ? ' blocked' : ''}" points="${hexPoints(b, h)}"/>`);
    if (h.number) {
      const red = h.number === 6 || h.number === 8;
      P.push(`<circle class="token" cx="${h.x}" cy="${h.y}" r="31"/>`);
      P.push(`<text class="token-t${red ? ' red' : ''}" x="${h.x}" y="${h.y + 8}">${h.number}</text>`);
      P.push(`<text class="token-pips" x="${h.x}" y="${h.y + 24}">${pipsFor(h.number)}</text>`);
    }
  });

  /* 街道 */
  for (const eId in st.roads) {
    const e = b.edges[eId], p = st.players[st.roads[eId]];
    const a = b.vertices[e.v[0]], c = b.vertices[e.v[1]];
    P.push(`<line class="road" x1="${a.x}" y1="${a.y}" x2="${c.x}" y2="${c.y}"/>`);
    P.push(`<line class="road-in" x1="${a.x}" y1="${a.y}" x2="${c.x}" y2="${c.y}" stroke="${p.color}"/>`);
  }

  /* 建物 */
  for (const vId in st.buildings) {
    const bd = st.buildings[vId], v = b.vertices[vId], col = st.players[bd.p].color;
    if (bd.type === 'settlement') {
      P.push(`<polygon class="piece-out" fill="${col}" points="${v.x - 16},${v.y + 14} ${v.x - 16},${v.y - 3} ${v.x},${v.y - 17} ${v.x + 16},${v.y - 3} ${v.x + 16},${v.y + 14}"/>`);
    } else {
      P.push(`<polygon class="piece-out" fill="${col}" points="${v.x - 22},${v.y + 15} ${v.x - 22},${v.y - 5} ${v.x - 6},${v.y - 5} ${v.x - 6},${v.y - 20} ${v.x + 8},${v.y - 20} ${v.x + 22},${v.y - 5} ${v.x + 22},${v.y + 15}"/>`);
    }
  }

  /* 盗賊 */
  const rh = b.hexes.find(h => h.id === st.robber);
  if (rh) {
    P.push(`<g class="robber-g"><ellipse class="robber" cx="${rh.x + 34}" cy="${rh.y + 22}" rx="15" ry="19"/>`);
    P.push(`<circle class="robber" cx="${rh.x + 34}" cy="${rh.y - 2}" r="11"/></g>`);
  }

  /* 有効手のハイライト＋当たり判定 */
  if (mode === 'robber') {
    valid.robberHexes.forEach(hid => {
      const h = b.hexes.find(x => x.id === hid);
      P.push(`<polygon class="spot pulse" points="${hexPoints(b, h)}" fill="rgba(240,228,200,.18)" stroke="#f0e4c8" stroke-width="4"/>`);
      P.push(`<polygon class="hit" data-hex="${hid}" points="${hexPoints(b, h)}"/>`);
    });
  }
  if (mode === 'road') {
    valid.roads.forEach(eId => {
      const e = b.edges[eId], a = b.vertices[e.v[0]], c = b.vertices[e.v[1]];
      P.push(`<g class="spot pulse"><line x1="${a.x}" y1="${a.y}" x2="${c.x}" y2="${c.y}"/></g>`);
      P.push(`<line class="hit" data-edge="${eId}" x1="${a.x}" y1="${a.y}" x2="${c.x}" y2="${c.y}" stroke-width="26"/>`);
    });
  }
  if (mode === 'settlement' || mode === 'city') {
    const list = mode === 'settlement' ? valid.settlements : valid.cities;
    list.forEach(vId => {
      const v = b.vertices[vId];
      P.push(`<g class="spot pulse"><circle cx="${v.x}" cy="${v.y}" r="17"/></g>`);
      P.push(`<circle class="hit" data-vertex="${vId}" cx="${v.x}" cy="${v.y}" r="24"/>`);
    });
  }

  /* サイコロ */
  if (st.turn.dice) {
    const [d1, d2] = st.turn.dice;
    const bx = maxX - 128, by = minY + 24;
    P.push('<g class="dice-g">');
    [d1, d2].forEach((d, i) => {
      P.push(`<rect x="${bx + i * 52}" y="${by}" width="44" height="44" rx="9"/>`);
      P.push(`<text x="${bx + i * 52 + 22}" y="${by + 33}">${d}</text>`);
    });
    P.push('</g>');
  }

  P.push('</svg>');
  const host = $('#board-host');
  host.innerHTML = P.join('');
  host.onclick = onBoardClick;
}

function onBoardClick(ev) {
  const t = ev.target.closest('[data-vertex],[data-edge],[data-hex]');
  if (!t) return;
  const mode = effectiveMode();
  if (t.dataset.hex) return act({ type: 'moveRobber', hex: t.dataset.hex });
  if (t.dataset.edge) { act({ type: 'placeRoad', edge: t.dataset.edge }); if (S.state.phase !== 'setup') S.mode = null; return; }
  if (t.dataset.vertex) {
    if (mode === 'city') act({ type: 'buildCity', vertex: t.dataset.vertex });
    else act({ type: 'placeSettlement', vertex: t.dataset.vertex });
    if (S.state.phase !== 'setup') S.mode = null;
  }
}

/* ---------------- プレイヤー一覧 ---------------- */
function renderPlayers() {
  const st = S.state;
  $('#game-code').textContent = `合言葉 ${S.code}`;
  const ul = $('#game-players'); ul.innerHTML = '';
  st.players.forEach(p => {
    const li = el('li', (actorIndex(st) === p.index ? 'turn ' : '') + (p.connected ? '' : 'off'));
    const d = el('span', 'dot'); d.style.background = p.color; li.append(d);
    li.append(el('span', 'pname', esc(p.name) + (p.index === st.me ? '<span class="tag" style="margin-left:6px">あなた</span>' : '')));
    li.append(el('span', 'vp', p.vp + '点'));
    const stats = el('div', 'pstats');
    stats.innerHTML =
      `<span>札 ${p.handCount}</span><span>発 ${p.devCount}</span><span>騎 ${p.knights}</span>` +
      (st.longestRoad.p === p.index ? '<span class="badge">最長路</span>' : '') +
      (st.largestArmy.p === p.index ? '<span class="badge">騎士力</span>' : '') +
      (p.connected ? '' : '<span>切断中</span>');
    li.append(stats);
    ul.append(li);
  });
}

function renderLog() {
  const box = $('#log');
  box.innerHTML = S.state.log.slice().reverse().map(l => `<div>${esc(l.text)}</div>`).join('');
}

/* ---------------- 手札 ---------------- */
function renderHand() {
  const st = S.state, p = me();
  const h = $('#hand'); h.innerHTML = '';
  RES.forEach(r => {
    const c = el('div', 'res-chip' + (p.res[r] ? '' : ' zero'));
    c.innerHTML = `<span>${RES_ICON[r]}</span><span class="n">${p.res[r]}</span>`;
    c.title = `${RES_JA[r]}（交易レート ${p.ratios[r]}:1）`;
    h.append(c);
  });

  const d = $('#devhand'); d.innerHTML = '';
  const counts = {};
  p.dev.forEach(c => counts[c] = (counts[c] || 0) + 1);
  Object.entries(counts).forEach(([card, n]) => {
    const b = el('button', 'dev-card', `${DEV_JA[card]}${n > 1 ? ' ×' + n : ''}`);
    b.title = DEV_DESC[card];
    b.disabled = !(isMyTurn() && !st.turn.devPlayed && (st.turn.step === 'main' || (st.turn.step === 'roll' && card === 'knight')));
    b.onclick = () => playDev(card);
    d.append(b);
  });
  const newCounts = {};
  p.devNew.forEach(c => newCounts[c] = (newCounts[c] || 0) + 1);
  Object.entries(newCounts).forEach(([card, n]) => {
    const b = el('button', 'dev-card new', `${DEV_JA[card]}${n > 1 ? ' ×' + n : ''}`);
    b.disabled = true; b.title = '購入した手番には使えません';
    d.append(b);
  });
  if (p.vpCards) d.append(el('span', 'dev-card', `勝利点 ×${p.vpCards}`));
}

/* ---------------- 操作ボタン ---------------- */
function renderActions() {
  const st = S.state, t = st.turn, box = $('#actions');
  box.innerHTML = '';
  if (st.phase === 'ended') {
    if (S.room && S.room.hostId === S.playerId) {
      const b = el('button', 'go', 'ロビーに戻る');
      b.onclick = () => socket.emit('newGame');
      box.append(b);
    }
    return;
  }
  if (st.phase === 'setup') return;

  const add = (label, cls, fn, disabled, title) => {
    const b = el('button', cls || '', label);
    b.disabled = !!disabled; if (title) b.title = title;
    b.onclick = fn; box.append(b); return b;
  };

  if (isMyTurn() && t.step === 'roll') add('サイコロを振る', 'go', () => act({ type: 'roll' }));

  if (canBuildNow()) {
    const mode = S.mode;
    add(`街道 ${COST_TEXT.road}`, mode === 'road' ? 'on' : '',
      () => { S.mode = mode === 'road' ? null : 'road'; renderAll(); },
      !afford(COSTS.road) || !st.valid.roads.length, '木材1・レンガ1');
    add(`開拓地 ${COST_TEXT.settlement}`, mode === 'settlement' ? 'on' : '',
      () => { S.mode = mode === 'settlement' ? null : 'settlement'; renderAll(); },
      !afford(COSTS.settlement) || !st.valid.settlements.length, '木材1・レンガ1・羊毛1・小麦1');
    add(`都市 ${COST_TEXT.city}`, mode === 'city' ? 'on' : '',
      () => { S.mode = mode === 'city' ? null : 'city'; renderAll(); },
      !afford(COSTS.city) || !st.valid.cities.length, '鉱石3・小麦2');
    add(`発展カード ${COST_TEXT.dev}`, '', () => act({ type: 'buyDev' }),
      !afford(COSTS.dev) || st.devLeft === 0, `羊毛1・小麦1・鉱石1（残り${st.devLeft}枚）`);
  }

  if (isMyTurn() && t.step === 'main') {
    add('交易', S.modal && S.modal.type === 'trade' ? 'on' : '', () => { S.modal = { type: 'trade' }; S.ms = {}; syncModal(); });
    add('手番を終える', 'go', () => { S.mode = null; act({ type: 'endTurn' }); });
  }
  if (isMyTurn() && t.step === 'special') {
    add('建設を終える', 'go', () => { S.mode = null; act({ type: 'endTurn' }); });
  }
  if (t.freeRoads > 0 && isMyTurn()) {
    box.append(el('span', 'muted', `無料の街道 残り${t.freeRoads}本`));
  }
}

/* ---------------- 案内バナー ---------------- */
function renderBanner() {
  const st = S.state, t = st.turn, name = st.players[actorIndex(st)].name;
  const mine = isMyTurn();
  let msg = '';
  if (st.phase === 'ended') msg = `🏆 ${st.players[st.winner].name} の勝利`;
  else if (st.phase === 'setup') {
    msg = mine
      ? (t.step === 'setupSettlement' ? '開拓地を置く場所を選んでください' : '街道を置く方向を選んでください')
      : `${name} が初期配置中`;
    msg += `（${st.setup.round}周目）`;
  } else if (t.step === 'discard') {
    msg = t.myDiscard ? `手札を ${t.myDiscard} 枚 捨ててください` : '他のプレイヤーが手札を捨てています';
  } else if (t.step === 'robber') msg = mine ? '盗賊を置くマスを選んでください' : `${name} が盗賊を移動中`;
  else if (t.step === 'steal') msg = mine ? '資源を奪う相手を選んでください' : `${name} が奪う相手を選んでいます`;
  else if (t.step === 'roll') msg = mine ? 'サイコロを振ってください' : `${name} の手番`;
  else if (t.step === 'special') msg = mine ? '特別建設フェイズ — 建設できます' : `特別建設フェイズ：${name}`;
  else msg = mine ? 'あなたの手番' : `${name} の手番`;
  $('#banner').textContent = msg;
}

/* ---------------- モーダル ---------------- */
function closeModal() { S.modal = null; S.ms = {}; syncModal(); }

function syncModal() {
  const st = S.state, t = st.turn;
  let forced = null;
  if (st.phase === 'ended') forced = { type: 'gameover' };
  else if (t.step === 'discard' && t.myDiscard > 0) forced = { type: 'discard' };
  else if (t.step === 'steal' && isMyTurn()) forced = { type: 'steal' };
  else if (st.trade && st.trade.from !== st.me && st.trade.responses[st.me] === undefined) forced = { type: 'tradeRespond' };

  if (forced) { if (!S.modal || S.modal.type !== forced.type) { S.modal = forced; S.ms = {}; } }
  else if (S.modal && ['discard', 'steal', 'tradeRespond', 'gameover'].includes(S.modal.type)) S.modal = null;

  const root = $('#modal-root');
  if (!S.modal) { root.classList.add('hidden'); root.innerHTML = ''; return; }
  root.classList.remove('hidden');
  root.innerHTML = '';
  const m = el('div', 'modal');
  root.append(m);
  ({
    discard: modalDiscard, steal: modalSteal, trade: modalTrade,
    tradeRespond: modalTradeRespond, plenty: modalPlenty,
    monopoly: modalMonopoly, gameover: modalGameOver,
  })[S.modal.type](m);
}

function counterRow(container, key, limits) {
  S.ms[key] = S.ms[key] || {};
  const row = el('div', 'counter-row');
  RES.forEach(r => {
    const c = el('div', 'counter');
    const cur = S.ms[key][r] || 0;
    c.innerHTML = `<span>${RES_ICON[r]}</span><span class="v">${cur}</span>`;
    const btns = el('div', 'btns');
    const minus = el('button', '', '−'), plus = el('button', '', '＋');
    minus.onclick = () => { S.ms[key][r] = Math.max(0, cur - 1); syncModal(); };
    plus.onclick = () => {
      const max = limits ? limits(r) : 99;
      S.ms[key][r] = Math.min(max, cur + 1); syncModal();
    };
    btns.append(minus, plus); c.append(btns); row.append(c);
  });
  container.append(row);
}
const sumMs = key => RES.reduce((s, r) => s + ((S.ms[key] || {})[r] || 0), 0);

function modalDiscard(m) {
  const need = S.state.turn.myDiscard, p = me();
  m.append(el('h3', '', `手札を ${need} 枚 捨てる`));
  m.append(el('p', 'sub', `手札 ${p.handCount} 枚。半分を捨てます。`));
  counterRow(m, 'discard', r => p.res[r]);
  const chosen = sumMs('discard');
  const acts = el('div', 'modal-actions');
  const b = el('button', 'primary', `捨てる（${chosen}/${need}）`);
  b.disabled = chosen !== need;
  b.onclick = () => { act({ type: 'discard', res: S.ms.discard }); closeModal(); };
  acts.append(b); m.append(acts);
}

function modalSteal(m) {
  m.append(el('h3', '', '資源を奪う相手を選ぶ'));
  const grid = el('div', 'choice-grid');
  S.state.turn.stealFrom.forEach(i => {
    const p = S.state.players[i];
    const b = el('button', 'choice', `${esc(p.name)}（${p.handCount}枚）`);
    b.onclick = () => { act({ type: 'steal', target: i }); closeModal(); };
    grid.append(b);
  });
  m.append(grid);
}

function modalTrade(m) {
  const st = S.state, p = me();
  m.append(el('h3', '', '交易'));

  /* 銀行・港 */
  m.append(el('p', 'sub', '銀行・港と交易する'));
  const bankRow = el('div', 'choice-grid');
  RES.forEach(r => {
    const ratio = p.ratios[r];
    const b = el('button', 'choice' + (S.ms.bankGive === r ? ' on' : ''), `${RES_ICON[r]} ×${ratio}`);
    b.disabled = p.res[r] < ratio;
    b.onclick = () => { S.ms.bankGive = r; syncModal(); };
    bankRow.append(b);
  });
  m.append(bankRow);
  if (S.ms.bankGive) {
    m.append(el('p', 'sub', '受け取る資源'));
    const wantRow = el('div', 'choice-grid');
    RES.forEach(r => {
      const b = el('button', 'choice', `${RES_ICON[r]} ${RES_JA[r]}`);
      b.disabled = st.bank[r] < 1 || r === S.ms.bankGive;
      b.onclick = () => { act({ type: 'bankTrade', giveRes: S.ms.bankGive, wantRes: r }); S.ms.bankGive = null; syncModal(); };
      wantRow.append(b);
    });
    m.append(wantRow);
  }

  /* プレイヤー間 */
  m.append(el('h3', '', 'プレイヤーに提案する'));
  if (st.trade && st.trade.from === st.me) {
    m.append(el('p', 'sub', '提案中 — 承諾した相手を選んで成立させてください'));
    const grid = el('div', 'choice-grid');
    st.players.forEach(o => {
      if (o.index === st.me) return;
      const r = st.trade.responses[o.index];
      const b = el('button', 'choice' + (r === 'accept' ? ' on' : ''),
        `${esc(o.name)}：${r === 'accept' ? '承諾' : r === 'decline' ? '拒否' : '検討中'}`);
      b.disabled = r !== 'accept';
      b.onclick = () => { act({ type: 'confirmTrade', target: o.index }); closeModal(); };
      grid.append(b);
    });
    m.append(grid);
    const acts = el('div', 'modal-actions');
    const c = el('button', 'ghost', '提案を取り下げる');
    c.onclick = () => act({ type: 'cancelTrade' });
    const cl = el('button', 'ghost', '閉じる'); cl.onclick = closeModal;
    acts.append(c, cl); m.append(acts);
    return;
  }
  m.append(el('p', 'sub', '渡す'));
  counterRow(m, 'give', r => p.res[r]);
  m.append(el('p', 'sub', 'もらう'));
  counterRow(m, 'want', () => 20);
  const acts = el('div', 'modal-actions');
  const send = el('button', 'primary', '提案する');
  send.disabled = sumMs('give') === 0 && sumMs('want') === 0;
  send.onclick = () => act({ type: 'offerTrade', give: S.ms.give, want: S.ms.want });
  const close = el('button', 'ghost', '閉じる'); close.onclick = closeModal;
  acts.append(close, send); m.append(acts);
}

function tradeSummary(t) {
  const f = o => RES.filter(r => o[r] > 0).map(r => `${RES_ICON[r]}×${o[r]}`).join(' ') || 'なし';
  return `渡す：${f(t.give)}　→　もらう：${f(t.want)}`;
}

function modalTradeRespond(m) {
  const st = S.state, t = st.trade;
  m.append(el('h3', '', `${esc(st.players[t.from].name)} からの交易提案`));
  m.append(el('p', 'sub', `${st.players[t.from].name} が ${tradeSummary(t)}`));
  const canDo = RES.every(r => me().res[r] >= t.want[r]);
  if (!canDo) m.append(el('p', 'sub', '※ 求められている資源が足りません'));
  const acts = el('div', 'modal-actions');
  const no = el('button', 'ghost', '断る');
  no.onclick = () => { act({ type: 'respondTrade', accept: false }); closeModal(); };
  const yes = el('button', 'primary', '承諾する');
  yes.disabled = !canDo;
  yes.onclick = () => { act({ type: 'respondTrade', accept: true }); closeModal(); };
  acts.append(no, yes); m.append(acts);
}

function playDev(card) {
  if (card === 'plenty') { S.modal = { type: 'plenty' }; S.ms = { picks: [] }; return syncModal(); }
  if (card === 'monopoly') { S.modal = { type: 'monopoly' }; S.ms = {}; return syncModal(); }
  act({ type: 'playDev', card });
}

function modalPlenty(m) {
  m.append(el('h3', '', '発見 — 資源を2枚選ぶ'));
  const picks = S.ms.picks || [];
  m.append(el('p', 'sub', picks.length ? `選択中：${picks.map(r => RES_JA[r]).join('・')}` : '同じ資源を2枚選ぶこともできます'));
  const grid = el('div', 'choice-grid');
  RES.forEach(r => {
    const b = el('button', 'choice', `${RES_ICON[r]} ${RES_JA[r]}`);
    b.disabled = S.state.bank[r] < 1;
    b.onclick = () => { S.ms.picks = picks.concat(r).slice(0, 2); syncModal(); };
    grid.append(b);
  });
  m.append(grid);
  const acts = el('div', 'modal-actions');
  const reset = el('button', 'ghost', '選び直す'); reset.onclick = () => { S.ms.picks = []; syncModal(); };
  const close = el('button', 'ghost', 'やめる'); close.onclick = closeModal;
  const go = el('button', 'primary', '受け取る');
  go.disabled = picks.length !== 2;
  go.onclick = () => { act({ type: 'playDev', card: 'plenty', picks }); closeModal(); };
  acts.append(close, reset, go); m.append(acts);
}

function modalMonopoly(m) {
  m.append(el('h3', '', '独占 — 集める資源を選ぶ'));
  const grid = el('div', 'choice-grid');
  RES.forEach(r => {
    const b = el('button', 'choice', `${RES_ICON[r]} ${RES_JA[r]}`);
    b.onclick = () => { act({ type: 'playDev', card: 'monopoly', res: r }); closeModal(); };
    grid.append(b);
  });
  m.append(grid);
  const acts = el('div', 'modal-actions');
  const close = el('button', 'ghost', 'やめる'); close.onclick = closeModal;
  acts.append(close); m.append(acts);
}

function modalGameOver(m) {
  const st = S.state;
  m.append(el('h3', '', `🏆 ${esc(st.players[st.winner].name)} の勝利`));
  const list = el('div');
  (st.finalScores || []).slice().sort((a, b) => b.vp - a.vp).forEach(s => {
    list.append(el('p', 'sub', `${esc(s.name)} — ${s.vp}点`));
  });
  m.append(list);
  const acts = el('div', 'modal-actions');
  const close = el('button', 'ghost', '盤面を見る'); close.onclick = closeModal;
  acts.append(close);
  if (S.room && S.room.hostId === S.playerId) {
    const again = el('button', 'primary', 'ロビーに戻る');
    again.onclick = () => { socket.emit('newGame'); closeModal(); };
    acts.append(again);
  }
  m.append(acts);
}

window.addEventListener('keydown', e => { if (e.key === 'Escape' && S.modal && S.modal.type === 'trade') closeModal(); });
window.addEventListener('resize', () => { if (S.state) renderBoard(); });
