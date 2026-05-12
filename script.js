/* ================================================================
   ChessLens — script.js
   Analiz motoru: chess-api.com (ücretsiz REST API, gerçek Stockfish)
   Worker / WASM / dosya indirme gerektirmez.
   ================================================================ */

'use strict';

// ── STATE ──────────────────────────────────────────────────────
let board       = null;
let game        = null;
let sfReady     = false;
let isAnalyzing = false;

let currentFen  = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
let currentTurn = 'w';
let topMoves    = [];

let previewTimer = null;
let toastTimer   = null;


// ── INIT ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initBoard();
  initEngine();
  bindEvents();
});


// ── CHESSBOARD ────────────────────────────────────────────────
function initBoard() {
  board = Chessboard('board', {
    position: 'start',
    draggable: false,
    pieceTheme: 'https://raw.githubusercontent.com/oakmac/chessboardjs/master/website/img/chesspieces/wikipedia/{piece}.png'
  });
  $(window).on('resize', () => board.resize());
}


// ── ENGINE: chess-api.com ─────────────────────────────────────
//  Ücretsiz REST API — gerçek Stockfish, derinlik 12'ye kadar.
//  CORS izinli, token gerektirmiyor, tarayıcıdan doğrudan çalışır.

const API_URL = 'https://chess-api.com/v1';

function initEngine() {
  setStatus('loading');
  document.getElementById('status-text').textContent = 'Bağlanıyor…';

  fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fen: currentFen, variants: 1, depth: 5 })
  })
  .then(() => { sfReady = true; setStatus('ready'); })
  .catch(() => { sfReady = true; setStatus('ready'); });
}

async function analyzePosition(fen) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fen,
      variants: 5,
      depth: 12,
      maxThinkingTime: 100
    })
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function parseResponse(data, fen) {
  const arr  = Array.isArray(data) ? data : [data];
  const moves = [];

  for (const m of arr) {
    if (!m) continue;

    const from  = m.from || (m.move ? m.move.slice(0, 2) : null);
    const to    = m.to   || (m.move ? m.move.slice(2, 4) : null);
    const promo = m.promotion || (m.move && m.move.length > 4 ? m.move[4] : null);
    if (!from || !to) continue;

    const tempGame = new Chess(fen);
    const moveObj  = tempGame.move({ from, to, promotion: promo || 'q' });
    if (!moveObj) continue;

    let score = null;
    if (typeof m.centipawns !== 'undefined' && m.centipawns !== null) {
      score = { type: 'cp', value: Number(m.centipawns) };
    } else if (typeof m.eval !== 'undefined' && m.eval !== null) {
      score = { type: 'cp', value: Math.round(Number(m.eval) * 100) };
    } else if (m.mate) {
      score = { type: 'mate', value: Number(m.mate) };
    }

    moves.push({ san: moveObj.san, uci: from + to + (promo || ''), from, to, promo, score, depth: m.depth || 12 });
    if (moves.length >= 3) break;
  }

  return moves;
}


// ── STATUS ────────────────────────────────────────────────────
function setStatus(state) {
  const dot  = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  dot.className = 'status-dot ' + state;
  if (state === 'loading') text.textContent = 'Bağlanıyor…';
  if (state === 'ready')   text.textContent = 'Hazır';
  if (state === 'error')   text.textContent = 'Hata';
}


// ── ANALYZE ───────────────────────────────────────────────────
async function startAnalysis(fen, turn) {
  if (isAnalyzing) return;

  currentFen  = fen;
  currentTurn = turn;
  topMoves    = [];
  isAnalyzing = true;

  document.getElementById('engine-dot').className = 'engine-dot thinking';
  document.getElementById('depth-chip').textContent = 'analiz ediliyor…';
  document.getElementById('analyze-btn').disabled = true;
  document.getElementById('analyze-btn').classList.add('loading');
  showLoadingMoves();

  try {
    const data = await analyzePosition(fen);
    topMoves   = parseResponse(data, fen);

    if (topMoves.length === 0) {
      showToast('Bu pozisyon için hamle bulunamadı', 'error');
      document.getElementById('moves-container').innerHTML = `
        <div class="placeholder"><span class="placeholder-icon">✕</span><p>Sonuç gelmedi.</p></div>`;
    } else {
      document.getElementById('depth-chip').textContent = `derinlik ${topMoves[0]?.depth || 12}`;
      if (topMoves[0]?.score) updateEvalBar(topMoves[0].score);
      renderMoves();
    }
  } catch (err) {
    console.error('[ChessLens] Analiz hatası:', err);
    showToast('Analiz başarısız: ' + err.message, 'error');
    document.getElementById('moves-container').innerHTML = `
      <div class="placeholder"><span class="placeholder-icon">✕</span><p>API bağlantı hatası. Tekrar dene.</p></div>`;
  } finally {
    isAnalyzing = false;
    document.getElementById('engine-dot').className = 'engine-dot done';
    document.getElementById('analyze-btn').disabled = false;
    document.getElementById('analyze-btn').classList.remove('loading');
  }
}

function showLoadingMoves() {
  document.getElementById('moves-container').innerHTML = `
    <div class="placeholder">
      <span class="placeholder-icon" style="animation:blink 1s infinite">⚙</span>
      <p>Analiz ediliyor…</p>
    </div>`;
}


// ── RENDER MOVES ──────────────────────────────────────────────
function renderMoves() {
  const container = document.getElementById('moves-container');
  if (topMoves.length === 0) return;

  const maxAbs = topMoves[0]?.score?.type === 'cp'
    ? Math.max(1, Math.abs(topMoves[0].score.value))
    : 1;

  container.innerHTML = topMoves.map((m, idx) => {
    const isBest    = idx === 0;
    const sc        = m.score;
    const scoreText = formatScore(sc);
    const scoreCls  = scoreColorClass(sc);

    let barPct = 30;
    if (sc?.type === 'cp')   barPct = Math.min(98, Math.max(10, Math.round((Math.abs(sc.value) / maxAbs) * 98)));
    if (sc?.type === 'mate') barPct = 98;

    return `
      <div class="move-card ${isBest ? 'best-move' : ''}"
           onclick="previewMove('${m.from}','${m.to}','${m.uci}')"
           role="button">
        <div class="move-bg-bar" style="width:${barPct}%"></div>
        <span class="move-rank">${isBest ? '★' : (idx + 1) + '.'}</span>
        <span class="move-san">${m.san}</span>
        <span class="move-uci">${m.from}${m.to}</span>
        <span class="move-score ${scoreCls}">${scoreText}</span>
      </div>`;
  }).join('');
}


// ── SCORE HELPERS ─────────────────────────────────────────────
function formatScore(score) {
  if (!score) return '?';
  if (score.type === 'mate') return `M${score.value > 0 ? '+' : ''}${score.value}`;
  const val = score.value / 100;
  return `${val >= 0 ? '+' : ''}${val.toFixed(2)}`;
}

function scoreColorClass(score) {
  if (!score)               return 'neutral';
  if (score.type === 'mate') return 'mate';
  if (score.value >  30)    return 'positive';
  if (score.value < -30)    return 'negative';
  return 'neutral';
}


// ── EVAL BAR ──────────────────────────────────────────────────
function updateEvalBar(score) {
  const fill  = document.getElementById('eval-fill');
  const label = document.getElementById('eval-label');
  document.getElementById('eval-bar-wrap').style.display = 'flex';

  let pct = 50;
  if (score.type === 'mate') {
    pct = score.value > 0 ? 95 : 5;
    label.textContent = score.value > 0 ? '+Mat' : '−Mat';
  } else {
    pct = 50 + Math.tanh(score.value / 400) * 45;
    const val = score.value / 100;
    label.textContent = `${val >= 0 ? '+' : ''}${val.toFixed(2)}`;
  }
  fill.style.width = pct.toFixed(1) + '%';
}


// ── PREVIEW MOVE ──────────────────────────────────────────────
function previewMove(from, to, uci) {
  clearHighlights();
  clearTimeout(previewTimer);

  $(`[data-square="${from}"]`).addClass('highlight-from');
  $(`[data-square="${to}"]`).addClass('highlight-to');

  const tempGame = new Chess(currentFen);
  const moveObj  = tempGame.move({ from, to, promotion: (uci[4] || 'q') });

  if (moveObj) {
    board.position(tempGame.fen(), true);
    showToast(`${from}→${to} önizlemesi`, 'ok');
  }

  previewTimer = setTimeout(() => {
    board.position(currentFen, true);
    clearHighlights();
  }, 2500);
}

function clearHighlights() {
  $('[data-square]').removeClass('highlight-from highlight-to');
}


// ── PGN LOAD ──────────────────────────────────────────────────
function loadAndAnalyze() {
  const raw = document.getElementById('pgn-input').value.trim();
  if (!raw) { showToast('PGN alanı boş!', 'error'); return; }

  let g = new Chess(), ok = g.load_pgn(raw);
  if (!ok) { g = new Chess(); ok = g.load_pgn(raw, { sloppy: true }); }
  if (!ok) { g = new Chess(); ok = g.load(raw); }
  if (!ok) { showToast('Geçersiz PGN!', 'error'); return; }

  game = g;
  const fen      = game.fen();
  const history  = game.history();
  const fullMove = Math.ceil(history.length / 2);
  const turn     = game.turn();
  const header   = game.header();

  board.position(fen, true);
  document.getElementById('turn-pill').textContent = turn === 'w' ? '⬜ Beyaz hamlesi' : '⬛ Siyah hamlesi';
  document.getElementById('meta-count').textContent = fullMove > 0 ? `${fullMove}. hamle tamamlandı` : '';
  if (header.White && header.Black) showToast(`${header.White} vs ${header.Black}`, 'ok');

  startAnalysis(fen, turn);
}


// ── RESET ─────────────────────────────────────────────────────
function resetApp() {
  isAnalyzing = false;
  document.getElementById('pgn-input').value = '';
  board.position('start');
  currentFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  document.getElementById('turn-pill').textContent   = 'Başlangıç pozisyonu';
  document.getElementById('meta-count').textContent  = '';
  document.getElementById('moves-container').innerHTML = `
    <div class="placeholder"><span class="placeholder-icon">⟳</span><p>PGN yapıştır ve Analiz Et'e bas</p></div>`;
  document.getElementById('engine-dot').className    = 'engine-dot';
  document.getElementById('depth-chip').textContent  = '—';
  document.getElementById('eval-bar-wrap').style.display = 'none';
  document.getElementById('analyze-btn').disabled    = false;
  document.getElementById('analyze-btn').classList.remove('loading');
  topMoves = [];
  clearHighlights();
  clearTimeout(previewTimer);
}


// ── TOAST ─────────────────────────────────────────────────────
function showToast(msg, type) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className   = `toast toast-${type || 'ok'} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}


// ── EVENTS ────────────────────────────────────────────────────
function bindEvents() {
  document.getElementById('analyze-btn').addEventListener('click', loadAndAnalyze);
  document.getElementById('clear-btn').addEventListener('click', resetApp);
  document.getElementById('pgn-input').addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Enter') loadAndAnalyze();
  });
  document.getElementById('flip-btn').addEventListener('click', () => {
    board.flip();
    document.getElementById('flip-btn').classList.toggle('flipped');
  });
}
