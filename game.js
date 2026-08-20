'use strict';

/* ============================================================
   カタン風ボードゲーム ルールエンジン（サーバー権威）
   ============================================================ */

const RESOURCES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
const RES_JA = { wood: '木材', brick: 'レンガ', sheep: '羊毛', wheat: '小麦', ore: '鉱石' };
const TERRAIN_RES = {
  forest: 'wood', hills: 'brick', pasture: 'sheep',
  fields: 'wheat', mountains: 'ore', desert: null,
};

const COSTS = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city: { ore: 3, wheat: 2 },
  dev: { sheep: 1, wheat: 1, ore: 1 },
};

const COLORS = ['#e5484d', '#3e8ee0', '#ece6d8', '#f08c22', '#3fa06a', '#9b59c8'];
const COLOR_NAMES = ['赤', '青', '白', '橙', '緑', '紫'];

const DEV_JA = {
  knight: '騎士', road: '街道建設', plenty: '発見',
  monopoly: '独占', vp: '勝利点',
};

function rnd(n) { return Math.floor(Math.random() * n); }
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1);[a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function emptyRes() { return { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 }; }
function totalRes(r) { return RESOURCES.reduce((s, k) => s + (r[k] || 0), 0); }

function defaultOptions() {
  return {
    maxPlayers: 4,
    victoryPoints: 10,
    bigBoard: false,       // 5-6人拡張ボード
    specialBuild: true,    // 特別建設フェイズ（5-6人拡張ルール）
    balancedNumbers: true, // 6と8を隣接させない
    friendlyRobber: false, // 2点以下のプレイヤーは盗賊の標的にならない
    discardLimit: 7,       // 7が出た時に捨てる手札枚数の閾値
    noRobberFirstTurns: false, // 最初の1周は7を振り直す
  };
}

/* ------------------------------------------------------------
   盤面生成
   ------------------------------------------------------------ */
function buildBoard(opts) {
  const big = !!opts.bigBoard;
  const rows = big ? [3, 4, 5, 6, 5, 4, 3] : [3, 4, 5, 4, 3];
  const R = 100, W = Math.sqrt(3) * R, VH = 1.5 * R;

  const hexes = [];
  let hid = 0;
  rows.forEach((c, j) => {
    for (let i = 0; i < c; i++) {
      hexes.push({
        id: 'h' + (hid++), row: j, col: i,
        x: (i - (c - 1) / 2) * W,
        y: (j - (rows.length - 1) / 2) * VH,
        terrain: null, number: null, vertices: [], edges: [], neighbors: [],
      });
    }
  });

  for (let a = 0; a < hexes.length; a++) {
    for (let b = a + 1; b < hexes.length; b++) {
      const d = Math.hypot(hexes[a].x - hexes[b].x, hexes[a].y - hexes[b].y);
      if (Math.abs(d - W) < 1) {
        hexes[a].neighbors.push(hexes[b].id);
        hexes[b].neighbors.push(hexes[a].id);
      }
    }
  }

  const terrainCounts = big
    ? { forest: 6, hills: 5, pasture: 6, fields: 6, mountains: 5, desert: 2 }
    : { forest: 4, hills: 3, pasture: 4, fields: 4, mountains: 3, desert: 1 };
  let baseTokens = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];
  if (big) baseTokens = baseTokens.concat([2, 3, 4, 5, 6, 8, 9, 10, 11, 12]);

  const byId = Object.fromEntries(hexes.map(h => [h.id, h]));
  const isRed = n => n === 6 || n === 8;

  for (let attempt = 0; attempt < 600; attempt++) {
    const terrains = [];
    for (const k in terrainCounts) for (let i = 0; i < terrainCounts[k]; i++) terrains.push(k);
    shuffle(terrains);
    const tokens = shuffle(baseTokens.slice());
    let ti = 0;
    hexes.forEach((h, i) => {
      h.terrain = terrains[i];
      h.number = h.terrain === 'desert' ? null : tokens[ti++];
    });
    if (!opts.balancedNumbers) break;
    let ok = true;
    for (const h of hexes) {
      if (h.number === null) continue;
      for (const nid of h.neighbors) {
        const n = byId[nid];
        if (n.number === null) continue;
        if (isRed(h.number) && isRed(n.number)) { ok = false; break; }
        if (h.number === n.number) { ok = false; break; }
      }
      if (!ok) break;
    }
    if (ok) break;
  }

  /* 頂点・辺を幾何から生成 */
  const vertices = {}, edges = {};
  const vkey = {}, ekey = {};
  let vid = 0, eid = 0;
  hexes.forEach(h => {
    const corners = [];
    for (let k = 0; k < 6; k++) {
      const a = Math.PI / 180 * (60 * k - 30);
      // 隣接ヘクスから同じ頂点が必ず同一キーになるよう 0.1 単位に量子化する
      const x = Math.round((h.x + R * Math.cos(a)) * 10) / 10;
      const y = Math.round((h.y + R * Math.sin(a)) * 10) / 10;
      const key = x + ',' + y;
      if (vkey[key] === undefined) {
        const v = { id: 'v' + (vid++), x, y, hexes: [], edges: [], adj: [] };
        vkey[key] = v.id; vertices[v.id] = v;
      }
      corners.push(vkey[key]);
    }
    h.vertices = corners;
    corners.forEach(c => vertices[c].hexes.push(h.id));
    for (let k = 0; k < 6; k++) {
      const a = corners[k], b = corners[(k + 1) % 6];
      const key = [a, b].sort().join('|');
      if (ekey[key] === undefined) {
        const e = { id: 'e' + (eid++), v: [a, b], hexes: [] };
        ekey[key] = e.id; edges[e.id] = e;
        vertices[a].edges.push(e.id); vertices[b].edges.push(e.id);
        vertices[a].adj.push(b); vertices[b].adj.push(a);
      }
      edges[ekey[key]].hexes.push(h.id);
      h.edges.push(ekey[key]);
    }
  });

  /* 港：外周の辺を順に辿って等間隔に配置 */
  const boundary = Object.values(edges).filter(e => e.hexes.length === 1);
  const bmap = {};
  boundary.forEach(e => e.v.forEach(v => { (bmap[v] = bmap[v] || []).push(e.id); }));
  const ring = [];
  {
    let cur = boundary[0], prevV = cur.v[0];
    const seen = new Set();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id); ring.push(cur.id);
      const nextV = cur.v[0] === prevV ? cur.v[1] : cur.v[0];
      const cand = (bmap[nextV] || []).filter(id => id !== cur.id && !seen.has(id));
      prevV = nextV;
      cur = cand.length ? edges[cand[0]] : null;
    }
  }

  const nPorts = big ? 11 : 9;
  const portTypes = shuffle(RESOURCES.concat(Array(nPorts - 5).fill('any')));
  const ports = [];
  for (let i = 0; i < nPorts; i++) {
    const eId = ring[Math.round(i * ring.length / nPorts) % ring.length];
    const e = edges[eId];
    const h = byId[e.hexes[0]];
    const mx = (vertices[e.v[0]].x + vertices[e.v[1]].x) / 2;
    const my = (vertices[e.v[0]].y + vertices[e.v[1]].y) / 2;
    const dx = mx - h.x, dy = my - h.y, len = Math.hypot(dx, dy) || 1;
    ports.push({
      id: 'p' + i, edge: eId, type: portTypes[i], vertices: e.v.slice(),
      x: +(mx + dx / len * 46).toFixed(2), y: +(my + dy / len * 46).toFixed(2),
      ax: mx, ay: my,
    });
  }

  const desert = hexes.find(h => h.terrain === 'desert');
  return {
    id: Math.random().toString(36).slice(2, 10),
    rows, radius: R, hexes, vertices, edges, ports,
    robber: desert ? desert.id : hexes[0].id,
  };
}

/* ------------------------------------------------------------
   ゲーム生成
   ------------------------------------------------------------ */
function buildDevDeck(big) {
  const d = [];
  const add = (t, n) => { for (let i = 0; i < n; i++) d.push(t); };
  add('knight', big ? 20 : 14);
  add('vp', big ? 6 : 5);
  add('road', big ? 3 : 2);
  add('plenty', big ? 3 : 2);
  add('monopoly', big ? 3 : 2);
  return shuffle(d);
}

function createGame(options, lobbyPlayers) {
  const opts = Object.assign(defaultOptions(), options);
  if (opts.maxPlayers > 4) opts.bigBoard = true;
  const board = buildBoard(opts);
  const bankEach = opts.bigBoard ? 24 : 19;

  const players = lobbyPlayers.map((p, i) => ({
    id: p.id, name: p.name, color: COLORS[i], colorName: COLOR_NAMES[i], index: i,
    res: emptyRes(), dev: [], devNew: [], knights: 0,
    pieces: { road: 15, settlement: 5, city: 4 },
    vpCards: 0, ports: [], connected: true,
  }));

  const order = players.map((_, i) => i);
  const setupOrder = order.concat(order.slice().reverse());

  const g = {
    phase: 'setup',
    opts, board, players,
    bank: Object.fromEntries(RESOURCES.map(r => [r, bankEach])),
    devDeck: buildDevDeck(opts.bigBoard),
    buildings: {},   // vertexId -> {type, p}
    roads: {},       // edgeId   -> playerIndex
    setup: { order: setupOrder, pos: 0, placedVertex: null },
    turn: {
      p: setupOrder[0], step: 'setupSettlement', dice: null, devPlayed: false,
      freeRoads: 0, discards: {}, stealFrom: [], special: null, round: 0,
    },
    trade: null,
    longestRoad: { p: null, len: 0 },
    largestArmy: { p: null, n: 0 },
    log: [],
    winner: null,
  };
  logMsg(g, `ゲーム開始（${players.length}人 / ${opts.victoryPoints}点先取）`);
  logMsg(g, `${players[g.turn.p].name} の初期配置`);
  return g;
}

function logMsg(g, text) {
  g.log.push({ t: Date.now(), text });
  if (g.log.length > 250) g.log.shift();
}

/* ------------------------------------------------------------
   ヘルパ
   ------------------------------------------------------------ */
const V = (g, id) => g.board.vertices[id];
const E = (g, id) => g.board.edges[id];
const H = (g, id) => g.board.hexes.find(h => h.id === id);

function canAfford(pl, cost) { return RESOURCES.every(r => (pl.res[r] || 0) >= (cost[r] || 0)); }
function pay(g, pl, cost) {
  RESOURCES.forEach(r => { if (cost[r]) { pl.res[r] -= cost[r]; g.bank[r] += cost[r]; } });
}
function give(g, pl, res, n) {
  const take = Math.min(n, g.bank[res]);
  pl.res[res] += take; g.bank[res] -= take;
  return take;
}

function vertexOpen(g, vId) {
  if (g.buildings[vId]) return false;
  return !V(g, vId).adj.some(a => g.buildings[a]);
}

function playerTouchesVertex(g, pi, vId) {
  const b = g.buildings[vId];
  if (b && b.p === pi) return true;
  return V(g, vId).edges.some(e => g.roads[e] === pi);
}

function validSettlements(g, pi, setup) {
  const out = [];
  const pl = g.players[pi];
  if (pl.pieces.settlement <= 0) return out;
  for (const vId in g.board.vertices) {
    if (!vertexOpen(g, vId)) continue;
    if (setup) { out.push(vId); continue; }
    if (V(g, vId).edges.some(e => g.roads[e] === pi)) out.push(vId);
  }
  return out;
}

function validRoads(g, pi, setupVertex) {
  const out = [];
  const pl = g.players[pi];
  if (pl.pieces.road <= 0) return out;
  for (const eId in g.board.edges) {
    if (g.roads[eId] !== undefined) continue;
    const e = E(g, eId);
    if (setupVertex) { if (e.v.includes(setupVertex)) out.push(eId); continue; }
    const ok = e.v.some(v => {
      const b = g.buildings[v];
      if (b) return b.p === pi;                       // 自分の建物に接続
      return V(g, v).edges.some(x => g.roads[x] === pi); // 自分の道に接続（他人の建物で遮断されない）
    });
    if (ok) out.push(eId);
  }
  return out;
}

function validCities(g, pi) {
  const pl = g.players[pi];
  if (pl.pieces.city <= 0) return [];
  return Object.keys(g.buildings).filter(v => g.buildings[v].p === pi && g.buildings[v].type === 'settlement');
}

function robberTargets(g, hexId, pi) {
  const h = H(g, hexId);
  const set = new Set();
  h.vertices.forEach(v => {
    const b = g.buildings[v];
    if (!b || b.p === pi) return;
    const tgt = g.players[b.p];
    if (totalRes(tgt.res) <= 0) return;
    if (g.opts.friendlyRobber && victoryPoints(g, b.p, true) <= 2) return;
    set.add(b.p);
  });
  return [...set];
}

function updatePorts(g, pi) {
  const pl = g.players[pi];
  const s = new Set();
  g.board.ports.forEach(p => {
    if (p.vertices.some(v => g.buildings[v] && g.buildings[v].p === pi)) s.add(p.type);
  });
  pl.ports = [...s];
}

function tradeRatio(pl, res) {
  if (pl.ports.includes(res)) return 2;
  if (pl.ports.includes('any')) return 3;
  return 4;
}

/* 最長交易路（辺のDFS、他プレイヤーの建物で分断） */
function longestRoadLength(g, pi) {
  const own = Object.keys(g.roads).filter(e => g.roads[e] === pi);
  if (!own.length) return 0;
  const ownSet = new Set(own);
  let best = 0;
  const passable = v => { const b = g.buildings[v]; return !b || b.p === pi; };

  const walk = (vFrom, used, isStart) => {
    let local = used.size;
    if (!isStart && !passable(vFrom)) return local; // 他人の建物で分断される
    for (const eId of V(g, vFrom).edges) {
      if (!ownSet.has(eId) || used.has(eId)) continue;
      const e = E(g, eId);
      const next = e.v[0] === vFrom ? e.v[1] : e.v[0];
      used.add(eId);
      local = Math.max(local, walk(next, used, false));
      used.delete(eId);
    }
    return local;
  };

  const starts = new Set();
  own.forEach(e => E(g, e).v.forEach(v => starts.add(v)));
  starts.forEach(v => { best = Math.max(best, walk(v, new Set(), true)); });
  return best;
}

function updateLongestRoad(g) {
  let bestP = g.longestRoad.p, bestLen = g.longestRoad.p === null ? 4 : g.longestRoad.len;
  const lens = g.players.map((_, i) => longestRoadLength(g, i));
  if (g.longestRoad.p !== null && lens[g.longestRoad.p] < 5) { bestP = null; bestLen = 4; }
  else if (g.longestRoad.p !== null) bestLen = lens[g.longestRoad.p];
  lens.forEach((l, i) => { if (l >= 5 && l > bestLen) { bestLen = l; bestP = i; } });
  if (bestP !== g.longestRoad.p) {
    g.longestRoad = { p: bestP, len: bestLen };
    if (bestP !== null) logMsg(g, `${g.players[bestP].name} が最長交易路を獲得（${bestLen}）`);
  } else g.longestRoad.len = bestLen;
}

function updateLargestArmy(g, pi) {
  const n = g.players[pi].knights;
  if (n >= 3 && n > g.largestArmy.n) {
    if (g.largestArmy.p !== pi) logMsg(g, `${g.players[pi].name} が最大騎士力を獲得（${n}）`);
    g.largestArmy = { p: pi, n };
  }
}

function victoryPoints(g, pi, publicOnly) {
  let vp = 0;
  for (const v in g.buildings) if (g.buildings[v].p === pi) vp += g.buildings[v].type === 'city' ? 2 : 1;
  if (g.longestRoad.p === pi) vp += 2;
  if (g.largestArmy.p === pi) vp += 2;
  if (!publicOnly) vp += g.players[pi].vpCards;
  return vp;
}

function checkWin(g, pi) {
  if (victoryPoints(g, pi) >= g.opts.victoryPoints) {
    g.phase = 'ended';
    g.winner = pi;
    logMsg(g, `🏆 ${g.players[pi].name} の勝利！（${victoryPoints(g, pi)}点）`);
    return true;
  }
  return false;
}

/* ------------------------------------------------------------
   有効手（クライアントのハイライト用）
   ------------------------------------------------------------ */
function validMoves(g, pi) {
  const t = g.turn;
  const out = { settlements: [], roads: [], cities: [], robberHexes: [], stealFrom: [] };
  if (g.phase === 'ended') return out;

  if (g.phase === 'setup') {
    if (t.p !== pi) return out;
    if (t.step === 'setupSettlement') out.settlements = validSettlements(g, pi, true);
    if (t.step === 'setupRoad') out.roads = validRoads(g, pi, g.setup.placedVertex);
    return out;
  }

  if (t.step === 'robber' && t.p === pi) {
    out.robberHexes = g.board.hexes.filter(h => h.id !== g.board.robber).map(h => h.id);
    return out;
  }
  if (t.step === 'steal' && t.p === pi) { out.stealFrom = t.stealFrom; return out; }

  const active = t.step === 'special' ? t.special : t.p;
  if (active !== pi) return out;
  if (t.step !== 'main' && t.step !== 'special') return out;

  const pl = g.players[pi];
  if (t.freeRoads > 0) { out.roads = validRoads(g, pi, null); return out; }
  if (canAfford(pl, COSTS.road)) out.roads = validRoads(g, pi, null);
  if (canAfford(pl, COSTS.settlement)) out.settlements = validSettlements(g, pi, false);
  if (canAfford(pl, COSTS.city)) out.cities = validCities(g, pi);
  return out;
}

/* ------------------------------------------------------------
   アクション処理
   ------------------------------------------------------------ */
function fail(msg) { return { ok: false, error: msg }; }
const OK = { ok: true };

function applyAction(g, playerId, a) {
  const pi = g.players.findIndex(p => p.id === playerId);
  if (pi < 0) return fail('プレイヤーが見つかりません');
  if (g.phase === 'ended') return fail('ゲームは終了しています');
  const pl = g.players[pi];
  const t = g.turn;

  switch (a.type) {

    /* ---- 初期配置 ---- */
    case 'placeSettlement': {
      if (g.phase === 'setup') {
        if (t.p !== pi || t.step !== 'setupSettlement') return fail('あなたの手番ではありません');
        if (!validSettlements(g, pi, true).includes(a.vertex)) return fail('そこには建てられません');
        g.buildings[a.vertex] = { type: 'settlement', p: pi };
        pl.pieces.settlement--;
        g.setup.placedVertex = a.vertex;
        updatePorts(g, pi);
        // 2周目は資源を得る
        if (g.setup.pos >= g.players.length) {
          V(g, a.vertex).hexes.forEach(hid => {
            const h = H(g, hid);
            const r = TERRAIN_RES[h.terrain];
            if (r) give(g, pl, r, 1);
          });
        }
        t.step = 'setupRoad';
        logMsg(g, `${pl.name} が開拓地を配置`);
        return OK;
      }
      /* ---- 通常の建設 ---- */
      const active = t.step === 'special' ? t.special : t.p;
      if (active !== pi || (t.step !== 'main' && t.step !== 'special')) return fail('今は建設できません');
      if (!canAfford(pl, COSTS.settlement)) return fail('資源が足りません');
      if (!validSettlements(g, pi, false).includes(a.vertex)) return fail('そこには建てられません');
      pay(g, pl, COSTS.settlement);
      g.buildings[a.vertex] = { type: 'settlement', p: pi };
      pl.pieces.settlement--;
      updatePorts(g, pi);
      updateLongestRoad(g);
      logMsg(g, `${pl.name} が開拓地を建設`);
      checkWin(g, pi);
      return OK;
    }

    case 'placeRoad': {
      if (g.phase === 'setup') {
        if (t.p !== pi || t.step !== 'setupRoad') return fail('あなたの手番ではありません');
        if (!validRoads(g, pi, g.setup.placedVertex).includes(a.edge)) return fail('そこには置けません');
        g.roads[a.edge] = pi; pl.pieces.road--;
        logMsg(g, `${pl.name} が街道を配置`);
        advanceSetup(g);
        return OK;
      }
      const active = t.step === 'special' ? t.special : t.p;
      if (active !== pi || (t.step !== 'main' && t.step !== 'special')) return fail('今は建設できません');
      if (!validRoads(g, pi, null).includes(a.edge)) return fail('そこには置けません');
      if (t.freeRoads > 0) {
        t.freeRoads--;
        logMsg(g, `${pl.name} が街道を建設（街道建設カード）`);
      } else {
        if (!canAfford(pl, COSTS.road)) return fail('資源が足りません');
        pay(g, pl, COSTS.road);
        logMsg(g, `${pl.name} が街道を建設`);
      }
      g.roads[a.edge] = pi; pl.pieces.road--;
      updateLongestRoad(g);
      checkWin(g, pi);
      return OK;
    }

    case 'buildCity': {
      const active = t.step === 'special' ? t.special : t.p;
      if (active !== pi || (t.step !== 'main' && t.step !== 'special')) return fail('今は建設できません');
      if (!canAfford(pl, COSTS.city)) return fail('資源が足りません');
      if (!validCities(g, pi).includes(a.vertex)) return fail('都市にできません');
      pay(g, pl, COSTS.city);
      g.buildings[a.vertex].type = 'city';
      pl.pieces.settlement++; pl.pieces.city--;
      logMsg(g, `${pl.name} が都市を建設`);
      checkWin(g, pi);
      return OK;
    }

    /* ---- サイコロ ---- */
    case 'roll': {
      if (t.p !== pi || t.step !== 'roll') return fail('今は振れません');
      let d1 = rnd(6) + 1, d2 = rnd(6) + 1;
      if (g.opts.noRobberFirstTurns && t.round < g.players.length) {
        let guard = 0;
        while (d1 + d2 === 7 && guard++ < 50) { d1 = rnd(6) + 1; d2 = rnd(6) + 1; }
      }
      t.dice = [d1, d2];
      const sum = d1 + d2;
      logMsg(g, `${pl.name} が ${d1}+${d2}=${sum} を出した`);
      if (sum === 7) {
        const need = {};
        g.players.forEach((p, i) => {
          const n = totalRes(p.res);
          if (n > g.opts.discardLimit) need[i] = Math.floor(n / 2);
        });
        t.discards = need;
        if (Object.keys(need).length) { t.step = 'discard'; logMsg(g, '手札の半分を捨ててください'); }
        else t.step = 'robber';
      } else {
        distribute(g, sum);
        t.step = 'main';
      }
      return OK;
    }

    case 'discard': {
      if (t.step !== 'discard') return fail('今は捨てられません');
      const need = t.discards[pi];
      if (!need) return fail('捨てる必要はありません');
      const sel = a.res || {};
      let sum = 0;
      for (const r of RESOURCES) {
        const n = Math.max(0, Math.floor(sel[r] || 0));
        if (n > pl.res[r]) return fail('手札が足りません');
        sum += n;
      }
      if (sum !== need) return fail(`${need}枚 選んでください`);
      for (const r of RESOURCES) { const n = Math.floor(sel[r] || 0); pl.res[r] -= n; g.bank[r] += n; }
      delete t.discards[pi];
      logMsg(g, `${pl.name} が ${need}枚 捨てた`);
      if (!Object.keys(t.discards).length) t.step = 'robber';
      return OK;
    }

    case 'moveRobber': {
      if (t.p !== pi || t.step !== 'robber') return fail('今は動かせません');
      if (a.hex === g.board.robber) return fail('別のマスに動かしてください');
      if (!H(g, a.hex)) return fail('不正なマスです');
      g.board.robber = a.hex;
      logMsg(g, `${pl.name} が盗賊を移動`);
      const targets = robberTargets(g, a.hex, pi);
      if (targets.length === 0) { finishRobber(g); }
      else if (targets.length === 1) { steal(g, pi, targets[0]); finishRobber(g); }
      else { t.stealFrom = targets; t.step = 'steal'; }
      return OK;
    }

    case 'steal': {
      if (t.p !== pi || t.step !== 'steal') return fail('今は選べません');
      if (!t.stealFrom.includes(a.target)) return fail('選べない相手です');
      steal(g, pi, a.target);
      t.stealFrom = [];
      finishRobber(g);
      return OK;
    }

    /* ---- 交易 ---- */
    case 'bankTrade': {
      if (t.p !== pi || t.step !== 'main') return fail('今は交易できません');
      const { giveRes, wantRes } = a;
      if (!RESOURCES.includes(giveRes) || !RESOURCES.includes(wantRes)) return fail('不正な資源です');
      const ratio = tradeRatio(pl, giveRes);
      if (pl.res[giveRes] < ratio) return fail(`${ratio}枚 必要です`);
      if (g.bank[wantRes] < 1) return fail('銀行にその資源がありません');
      pl.res[giveRes] -= ratio; g.bank[giveRes] += ratio;
      give(g, pl, wantRes, 1);
      logMsg(g, `${pl.name} が銀行と交易（${RES_JA[giveRes]}×${ratio} → ${RES_JA[wantRes]}）`);
      return OK;
    }

    case 'offerTrade': {
      if (t.p !== pi || t.step !== 'main') return fail('今は交易できません');
      const giveR = sanitizeRes(a.give), wantR = sanitizeRes(a.want);
      if (totalRes(giveR) === 0 && totalRes(wantR) === 0) return fail('内容を選んでください');
      if (!RESOURCES.every(r => pl.res[r] >= giveR[r])) return fail('渡す資源が足りません');
      g.trade = { from: pi, give: giveR, want: wantR, responses: {} };
      logMsg(g, `${pl.name} が交易を提案`);
      return OK;
    }

    case 'respondTrade': {
      if (!g.trade) return fail('提案がありません');
      if (g.trade.from === pi) return fail('自分の提案です');
      g.trade.responses[pi] = a.accept ? 'accept' : 'decline';
      return OK;
    }

    case 'confirmTrade': {
      if (!g.trade || g.trade.from !== pi) return fail('提案がありません');
      const tp = a.target;
      if (g.trade.responses[tp] !== 'accept') return fail('その相手は承諾していません');
      const other = g.players[tp];
      if (!RESOURCES.every(r => pl.res[r] >= g.trade.give[r])) return fail('資源が足りません');
      if (!RESOURCES.every(r => other.res[r] >= g.trade.want[r])) return fail('相手の資源が足りません');
      RESOURCES.forEach(r => {
        pl.res[r] -= g.trade.give[r]; other.res[r] += g.trade.give[r];
        other.res[r] -= g.trade.want[r]; pl.res[r] += g.trade.want[r];
      });
      logMsg(g, `${pl.name} ⇄ ${other.name} が交易成立`);
      g.trade = null;
      return OK;
    }

    case 'cancelTrade': {
      if (!g.trade || g.trade.from !== pi) return fail('提案がありません');
      g.trade = null;
      return OK;
    }

    /* ---- 発展カード ---- */
    case 'buyDev': {
      const active = t.step === 'special' ? t.special : t.p;
      if (active !== pi || (t.step !== 'main' && t.step !== 'special')) return fail('今は購入できません');
      if (!g.devDeck.length) return fail('発展カードは品切れです');
      if (!canAfford(pl, COSTS.dev)) return fail('資源が足りません');
      pay(g, pl, COSTS.dev);
      const card = g.devDeck.pop();
      if (card === 'vp') { pl.vpCards++; }
      else pl.devNew.push(card);
      logMsg(g, `${pl.name} が発展カードを購入`);
      if (card === 'vp') checkWin(g, pi);
      return OK;
    }

    case 'playDev': {
      if (t.p !== pi) return fail('あなたの手番ではありません');
      if (t.step !== 'main' && t.step !== 'roll') return fail('今は使えません');
      if (t.devPlayed) return fail('発展カードは1手番に1枚までです');
      const idx = pl.dev.indexOf(a.card);
      if (idx < 0) return fail('そのカードを持っていません');

      if (a.card === 'knight') {
        pl.dev.splice(idx, 1); pl.knights++; t.devPlayed = true;
        updateLargestArmy(g, pi);
        logMsg(g, `${pl.name} が騎士カードを使用`);
        t.preRoll = (t.step === 'roll');
        t.step = 'robber';
        checkWin(g, pi);
        return OK;
      }
      if (t.step !== 'main') return fail('サイコロを振ってから使用してください');

      if (a.card === 'road') {
        pl.dev.splice(idx, 1); t.devPlayed = true;
        t.freeRoads = Math.min(2, pl.pieces.road);
        logMsg(g, `${pl.name} が街道建設カードを使用`);
        if (t.freeRoads === 0) logMsg(g, '街道コマがありません');
        return OK;
      }
      if (a.card === 'plenty') {
        const picks = (a.picks || []).filter(r => RESOURCES.includes(r)).slice(0, 2);
        if (picks.length !== 2) return fail('資源を2つ選んでください');
        pl.dev.splice(idx, 1); t.devPlayed = true;
        picks.forEach(r => give(g, pl, r, 1));
        logMsg(g, `${pl.name} が発見カードを使用（${picks.map(r => RES_JA[r]).join('・')}）`);
        return OK;
      }
      if (a.card === 'monopoly') {
        if (!RESOURCES.includes(a.res)) return fail('資源を選んでください');
        pl.dev.splice(idx, 1); t.devPlayed = true;
        let got = 0;
        g.players.forEach((o, i) => {
          if (i === pi) return;
          got += o.res[a.res]; pl.res[a.res] += o.res[a.res]; o.res[a.res] = 0;
        });
        logMsg(g, `${pl.name} が独占カードを使用（${RES_JA[a.res]} ${got}枚 獲得）`);
        return OK;
      }
      return fail('不正なカードです');
    }

    /* ---- 手番終了 ---- */
    case 'endTurn': {
      if (t.step === 'special') {
        if (t.special !== pi) return fail('あなたの番ではありません');
        nextSpecial(g);
        return OK;
      }
      if (t.p !== pi) return fail('あなたの手番ではありません');
      if (t.step !== 'main') return fail('まだ終了できません');
      if (t.freeRoads > 0) t.freeRoads = 0;
      g.trade = null;
      endTurn(g);
      return OK;
    }
  }
  return fail('不明な操作です');
}

function sanitizeRes(o) {
  const r = emptyRes();
  RESOURCES.forEach(k => { r[k] = Math.max(0, Math.floor((o && o[k]) || 0)); });
  return r;
}

function finishRobber(g) {
  g.turn.step = g.turn.preRoll ? 'roll' : 'main';
  g.turn.preRoll = false;
}

function steal(g, pi, target) {
  const from = g.players[target], to = g.players[pi];
  const pool = [];
  RESOURCES.forEach(r => { for (let i = 0; i < from.res[r]; i++) pool.push(r); });
  if (!pool.length) return;
  const r = pool[rnd(pool.length)];
  from.res[r]--; to.res[r]++;
  logMsg(g, `${to.name} が ${from.name} から資源を1枚奪った`);
}

function distribute(g, sum) {
  const claims = {}; // res -> [{pi, n}]
  g.board.hexes.forEach(h => {
    if (h.number !== sum || h.id === g.board.robber) return;
    const r = TERRAIN_RES[h.terrain];
    if (!r) return;
    h.vertices.forEach(v => {
      const b = g.buildings[v];
      if (!b) return;
      (claims[r] = claims[r] || []).push({ pi: b.p, n: b.type === 'city' ? 2 : 1 });
    });
  });
  const gained = {};
  for (const r in claims) {
    const list = claims[r];
    const totals = {};
    list.forEach(c => { totals[c.pi] = (totals[c.pi] || 0) + c.n; });
    const need = Object.values(totals).reduce((a, b) => a + b, 0);
    if (need > g.bank[r] && Object.keys(totals).length > 1) {
      logMsg(g, `${RES_JA[r]}が銀行に足りず、誰も受け取れません`);
      continue;
    }
    for (const pi in totals) {
      const got = give(g, g.players[pi], r, totals[pi]);
      if (got > 0) {
        gained[pi] = gained[pi] || [];
        gained[pi].push(`${RES_JA[r]}×${got}`);
      }
    }
  }
  const parts = Object.keys(gained).map(pi => `${g.players[pi].name}: ${gained[pi].join(' ')}`);
  logMsg(g, parts.length ? '産出 → ' + parts.join(' / ') : '産出なし');
}

function advanceSetup(g) {
  g.setup.pos++;
  g.setup.placedVertex = null;
  if (g.setup.pos >= g.setup.order.length) {
    g.phase = 'play';
    g.turn.p = 0;
    g.turn.step = 'roll';
    g.turn.round = 0;
    logMsg(g, `初期配置完了 — ${g.players[0].name} の手番`);
    startTurnUpkeep(g);
    return;
  }
  g.turn.p = g.setup.order[g.setup.pos];
  g.turn.step = 'setupSettlement';
  logMsg(g, `${g.players[g.turn.p].name} の初期配置`);
}

function startTurnUpkeep(g) {
  const pl = g.players[g.turn.p];
  pl.dev = pl.dev.concat(pl.devNew);
  pl.devNew = [];
  g.turn.devPlayed = false;
  g.turn.freeRoads = 0;
  g.turn.dice = null;
  g.trade = null;
}

function endTurn(g) {
  const n = g.players.length;
  if (g.opts.specialBuild && n > 4) {
    const queue = [];
    for (let i = 1; i < n; i++) queue.push((g.turn.p + i) % n);
    g.turn.specialQueue = queue;
    g.turn.special = queue[0];
    g.turn.step = 'special';
    logMsg(g, `特別建設フェイズ — ${g.players[queue[0]].name}`);
    return;
  }
  nextPlayer(g);
}

function nextSpecial(g) {
  const q = g.turn.specialQueue || [];
  q.shift();
  if (q.length) {
    g.turn.special = q[0];
    logMsg(g, `特別建設フェイズ — ${g.players[q[0]].name}`);
    return;
  }
  g.turn.special = null;
  g.turn.specialQueue = null;
  nextPlayer(g);
}

function nextPlayer(g) {
  g.turn.p = (g.turn.p + 1) % g.players.length;
  g.turn.step = 'roll';
  g.turn.special = null;
  g.turn.round++;
  startTurnUpkeep(g);
  logMsg(g, `${g.players[g.turn.p].name} の手番`);
}

/* ------------------------------------------------------------
   クライアントへ送る状態（秘匿情報をマスク）
   ------------------------------------------------------------ */
function publicState(g, playerId) {
  const pi = g.players.findIndex(p => p.id === playerId);
  return {
    phase: g.phase,
    opts: g.opts,
    boardId: g.board.id,
    robber: g.board.robber,
    buildings: g.buildings,
    roads: g.roads,
    bank: g.bank,
    devLeft: g.devDeck.length,
    turn: {
      p: g.turn.p, step: g.turn.step, dice: g.turn.dice,
      devPlayed: g.turn.devPlayed, freeRoads: g.turn.freeRoads,
      special: g.turn.special,
      discardsPending: Object.keys(g.turn.discards || {}).map(Number),
      myDiscard: (g.turn.discards || {})[pi] || 0,
      stealFrom: g.turn.step === 'steal' ? g.turn.stealFrom : [],
    },
    setup: g.phase === 'setup' ? { pos: g.setup.pos, round: g.setup.pos >= g.players.length ? 2 : 1 } : null,
    longestRoad: g.longestRoad,
    largestArmy: g.largestArmy,
    trade: g.trade ? {
      from: g.trade.from, give: g.trade.give, want: g.trade.want,
      responses: g.trade.responses,
    } : null,
    winner: g.winner,
    me: pi,
    players: g.players.map((p, i) => ({
      id: p.id, name: p.name, color: p.color, colorName: p.colorName, index: i,
      connected: p.connected,
      handCount: totalRes(p.res),
      devCount: p.dev.length + p.devNew.length,
      knights: p.knights,
      pieces: p.pieces,
      ports: p.ports,
      vp: victoryPoints(g, i, i !== pi),
      res: i === pi ? p.res : null,
      dev: i === pi ? p.dev : null,
      devNew: i === pi ? p.devNew : null,
      vpCards: i === pi ? p.vpCards : 0,
      ratios: i === pi ? Object.fromEntries(RESOURCES.map(r => [r, tradeRatio(p, r)])) : null,
    })),
    valid: pi >= 0 ? validMoves(g, pi) : { settlements: [], roads: [], cities: [], robberHexes: [], stealFrom: [] },
    log: g.log.slice(-60),
    finalScores: g.phase === 'ended'
      ? g.players.map((p, i) => ({ name: p.name, vp: victoryPoints(g, i) })) : null,
  };
}

module.exports = {
  RESOURCES, RES_JA, DEV_JA, COSTS, COLORS, COLOR_NAMES,
  defaultOptions, createGame, applyAction, publicState, buildBoard,
};
