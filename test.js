'use strict';
/* ランダムな自動対戦でルールエンジンを検証する簡易テスト */
const { createGame, applyAction, publicState, buildBoard, RESOURCES } = require('./game');

function assert(c, m) { if (!c) { console.error('✗ ' + m); process.exitCode = 1; } }

/* --- 盤面の整合性 --- */
[false, true].forEach(big => {
  const b = buildBoard({ bigBoard: big, balancedNumbers: true });
  const nHex = big ? 30 : 19;
  assert(b.hexes.length === nHex, `hex count ${big} = ${b.hexes.length}`);
  const V = Object.keys(b.vertices).length, E = Object.keys(b.edges).length;
  assert(V - E + b.hexes.length + 1 === 2, `オイラーの多面体定理 (V=${V} E=${E})`);
  assert(b.ports.length === (big ? 11 : 9), `ports ${big} = ${b.ports.length}`);
  assert(new Set(b.ports.map(p => p.edge)).size === b.ports.length, '港が同じ辺に重複');
  Object.values(b.vertices).forEach(v => {
    assert(v.hexes.length >= 1 && v.hexes.length <= 3, 'vertex hex fanout');
    assert(v.adj.length >= 2 && v.adj.length <= 3, 'vertex degree ' + v.adj.length);
  });
  Object.values(b.edges).forEach(e => assert(e.hexes.length <= 2, 'edge hex fanout'));
  const nums = b.hexes.filter(h => h.number).length;
  assert(nums === (big ? 28 : 18), 'number tokens ' + nums);
  const inner = b.hexes.filter(h => h.vertices.every(v => b.vertices[v].hexes.length === 3));
  assert(inner.length > 0, 'has interior hexes');
});
console.log('✓ 盤面生成');

/* --- ランダム対戦 --- */
function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

function randomGame(n, opts) {
  const lobby = Array.from({ length: n }, (_, i) => ({ id: 'P' + i, name: 'P' + i }));
  const g = createGame(Object.assign({ maxPlayers: n }, opts), lobby);
  let steps = 0;
  while (g.phase !== 'ended' && steps < 40000) {
    steps++;
    const t = g.turn;

    if (t.step === 'discard') {
      const pi = Object.keys(t.discards)[0];
      const pl = g.players[pi];
      const need = t.discards[pi];
      const sel = {}; let left = need;
      RESOURCES.forEach(r => { const take = Math.min(pl.res[r], left); sel[r] = take; left -= take; });
      const r = applyAction(g, pl.id, { type: 'discard', res: sel });
      assert(r.ok, 'discard: ' + r.error);
      continue;
    }

    const active = t.step === 'special' ? t.special : t.p;
    const pl = g.players[active];
    const st = publicState(g, pl.id);
    const v = st.valid;

    if (g.phase === 'setup') {
      const r = t.step === 'setupSettlement'
        ? applyAction(g, pl.id, { type: 'placeSettlement', vertex: pick(v.settlements) })
        : applyAction(g, pl.id, { type: 'placeRoad', edge: pick(v.roads) });
      assert(r.ok, 'setup: ' + r.error);
      continue;
    }

    if (t.step === 'roll') { assert(applyAction(g, pl.id, { type: 'roll' }).ok, 'roll'); continue; }
    if (t.step === 'robber') {
      const hex = pick(g.board.hexes.filter(h => h.id !== g.board.robber)).id;
      assert(applyAction(g, pl.id, { type: 'moveRobber', hex }).ok, 'robber');
      continue;
    }
    if (t.step === 'steal') {
      assert(applyAction(g, pl.id, { type: 'steal', target: pick(t.stealFrom) }).ok, 'steal');
      continue;
    }

    /* main / special */
    const moves = [];
    if (v.cities.length) moves.push(() => applyAction(g, pl.id, { type: 'buildCity', vertex: pick(v.cities) }));
    if (v.settlements.length) moves.push(() => applyAction(g, pl.id, { type: 'placeSettlement', vertex: pick(v.settlements) }));
    if (v.roads.length) moves.push(() => applyAction(g, pl.id, { type: 'placeRoad', edge: pick(v.roads) }));
    if (g.devDeck.length) moves.push(() => applyAction(g, pl.id, { type: 'buyDev' }));
    if (t.step === 'main') {
      pl.dev.forEach(c => moves.push(() => applyAction(g, pl.id, {
        type: 'playDev', card: c,
        picks: [pick(RESOURCES), pick(RESOURCES)], res: pick(RESOURCES),
      })));
      // 銀行交易
      RESOURCES.forEach(r => {
        if (pl.res[r] >= 4) moves.push(() => applyAction(g, pl.id, { type: 'bankTrade', giveRes: r, wantRes: pick(RESOURCES.filter(x => x !== r)) }));
      });
    }
    if (moves.length && Math.random() < 0.75) {
      const r = moves[Math.floor(Math.random() * moves.length)]();
      if (!r.ok && !/資源|品切れ|コマ|1枚まで/.test(r.error)) assert(false, 'move: ' + r.error);
      continue;
    }
    const r = applyAction(g, pl.id, { type: 'endTurn' });
    assert(r.ok, 'endTurn: ' + r.error);
  }

  /* 不変条件 */
  RESOURCES.forEach(r => {
    const held = g.players.reduce((s, p) => s + p.res[r], 0);
    assert(g.bank[r] >= 0, 'bank not negative');
    assert(held + g.bank[r] === (g.opts.bigBoard ? 24 : 19), `resource conservation ${r}: ${held}+${g.bank[r]}`);
  });
  g.players.forEach(p => {
    assert(p.pieces.road >= 0 && p.pieces.settlement >= 0 && p.pieces.city >= 0, 'piece counts');
    RESOURCES.forEach(r => assert(p.res[r] >= 0, 'no negative hand'));
  });
  const settleV = Object.keys(g.buildings);
  settleV.forEach(v => g.board.vertices[v].adj.forEach(a =>
    assert(!g.buildings[a], '距離ルール違反')));
  return { steps, ended: g.phase === 'ended', turns: g.turn.round };
}

let ok = 0, totalSteps = 0;
const configs = [
  { n: 3, o: {} },
  { n: 4, o: {} },
  { n: 4, o: { victoryPoints: 8, friendlyRobber: true } },
  { n: 5, o: { specialBuild: true } },
  { n: 6, o: { specialBuild: true, discardLimit: 9 } },
];
for (const c of configs) {
  for (let i = 0; i < 6; i++) {
    const r = randomGame(c.n, c.o);
    totalSteps += r.steps;
    assert(r.ended, `${c.n}人戦が終局しなかった（${r.steps}手）`);
    if (r.ended) ok++;
  }
}
console.log(`✓ ランダム対戦 ${ok}/${configs.length * 6} 局が正常終局（延べ${totalSteps}操作）`);
if (!process.exitCode) console.log('\nすべてのテストに合格しました。');
