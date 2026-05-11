/* ================================================================
   ChessLens — script.js
   Client-side PGN analyzer with Single-File Stockfish (ASM.js)
   ================================================================ */

'use strict';

// ── STATE ──────────────────────────────────────────────────────
let board        = null;   
let game         = null;   
let stockfish    = null;   
let sfReady      = false;  
let isAnalyzing  = false;

let currentFen  = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
let currentTurn = 'w';     

let topMoves    = {};      
let bestDepth   = 0;

let previewTimer = null;
let toastTimer   = null;


// ── INIT ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initBoard();
  initStockfish();
  bindEvents();
});


// ── CHESSBOARD ────────────────────────────────────────────────
function initBoard() {
  board = Chessboard('board', {
    position: 'start',
    draggable: false,
    pieceTheme: 'https://raw.githubusercontent.com/oakmac/chessboardjs/master/website/img/chesspieces/wikipedia/{piece}.png'
  });
  $(window).on('resize', () => {
    if (board) board.resize();
  });
}


// ── STOCKFISH WORKER (TEK PARÇA ASM.JS) ──────────────────────────
const SF_URL = 'https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js';

function initStockfish() {
  setStatus('loading');
  document.getElementById('status-text').textContent = 'Motor İndiriliyor…';

  fetch(SF_URL)
    .then(res => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    })
    .then(code => {
      document.getElementById('status-text').textContent = 'Başlatılıyor…';

      // İndirilen kodun sonuna motoru "uyandıran" fonksiyonu ekliyoruz (Kritik Çözüm)
      const blobCode = code + '\nif (typeof STOCKFISH === "function") { STOCKFISH(); }';
      const blob = new Blob([blobCode], { type: 'application/javascript' });
      const worker = new Worker(URL.createObjectURL(blob));

      const readyTimeout = setTimeout(() => {
        if (!sfReady) {
          console.error('[ChessLens] readyok zaman aşımı!');
          worker.terminate();
          setStatus('error');
          showToast('Motor başlatılamadı', 'error');
        }
      }, 15000);

      worker.onmessage = (e) => {
        if (e.data === 'readyok') clearTimeout(readyTimeout);
        handleSFMessage(e.data);
      };

      worker.onerror = (e) => {
        clearTimeout(readyTimeout);
        console.error('[ChessLens] Worker hatası:', e);
        setStatus('error');
        showToast('Worker çöktü', 'error');
      };

      stockfish = worker;

      stockfish.postMessage('uci');
      stockfish.postMessage('setoption name MultiPV value 3');
      stockfish.postMessage('setoption name Threads value 1');
      stockfish.postMessage('setoption name Hash value 32');
      stockfish.postMessage('isready');
    })
    .catch(err => {
      console.error('[ChessLens] Fetch hatası:', err);
      setStatus('error');
      showToast('Motor indirilemedi, bağlantıyı kontrol et', 'error');
    });
}

function setStatus(state) {
  const dot  = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  dot.className = 'status-dot ' + state;
  if (state === 'loading') text.textContent = 'Yükleniyor…';
  if (state === 'ready')   text.textContent = 'Hazır';
  if (state === 'error')   text.textContent = 'Hata';
}


// ── STOCKFISH MESSAGE HANDLER ─────────────────────────────────
function handleSFMessage(line) {
  if (line === 'readyok') {
    sfReady = true;
    setStatus('ready');
    return;
  }

  if (line.startsWith('bestmove')) {
    finalizeAnalysis();
    return;
  }

  if (!line.startsWith('info')) return;

  const depth   = extractInt(line, /\bdepth (\d+)/);
  const multipv = extractInt(line, /\bmultipv (\d+)/);
  const pvMove  = extractStr(line, /\bpv ([a-h][1-8][a-h][1-8][qrbn]?)/);

  if (depth === null || multipv === null || !pvMove) return;
  if (depth < 5) return; 

  bestDepth = Math.max(bestDepth, depth);

  let score = null;
  const cp   = extractInt(line, /\bscore cp (-?\d+)/);
  const mate = extractInt(line, /\bscore mate (-?\d+)/);

  if (cp !== null) {
    const normalized = currentTurn === 'b' ? -cp : cp;
    score = { type: 'cp', value: normalized };
  } else if (mate !== null) {
    const normalized = currentTurn === 'b' ? -mate : mate;
    score = { type: 'mate', value: normalized };
  }

  const tempGame = new Chess(currentFen);
  const moveObj  = tempGame.move({
    from:      pvMove.slice(0, 2),
    to:        pvMove.slice(2, 4),
    promotion: pvMove[4] || 'q'
  });
  if (!moveObj) return;

  topMoves[multipv] = {
    san:   moveObj.san,
    uci:   pvMove,
    from:  pvMove.slice(0, 2),
    to:    pvMove.slice(2, 4),
    promo: pvMove[4] || null,
    score: score,
    depth: depth
  };

  renderMoves();
  document.getElementById('depth-chip').textContent = `derinlik ${bestDepth}`;

  if (multipv === 1 && score) updateEvalBar(score);
}

function extractInt(str, rx) {
  const m = str.match(rx);
  return m ? parseInt(m[1], 10) : null;
}
function extractStr(str, rx) {
  const m = str.match(rx);
  return m ? m[1] : null;
}


// ── ANALYZE ───────────────────────────────────────────────────
function startAnalysis(fen, turn) {
  if (!sfReady) {
    showToast('Motor henüz hazır değil, bekle…', 'error');
    return;
  }

  currentFen  = fen;
  currentTurn = turn;
  topMoves    = {};
  bestDepth   = 0;
  isAnalyzing = true;

  document.getElementById('engine-dot').className = 'engine-dot thinking';
  document.getElementById('depth-chip').textContent = 'analiz ediliyor…';
  document.getElementById('analyze-btn').disabled = true;
  document.getElementById('analyze-btn').classList.add('loading');

  showLoadingMoves();

  stockfish.postMessage('stop');
  stockfish.postMessage('ucinewgame');
  stockfish.postMessage('position fen ' + fen);
  stockfish.postMessage('go depth 22 movetime 6000');
}

function finalizeAnalysis() {
  isAnalyzing = false;
  document.getElementById('engine-dot').className = 'engine-dot done';
  document.getElementById('analyze-btn').disabled = false;
  document.getElementById('analyze-btn').classList.remove('loading');
  renderMoves();
}

function showLoadingMoves() {
  document.getElementById('moves-container').innerHTML = `
    <div class="placeholder">
      <span class="placeholder-icon" style="animation:blink 1s infinite">⚙</span>
      <p>Stockfish hesaplıyor…</p>
    </div>`;
}


// ── RENDER MOVES ──────────────────────────────────────────────
function renderMoves() {
  const container = document.getElementById('moves-container');
  const keys = [1, 2, 3].filter(k => topMoves[k]);
  if (keys.length === 0) return;

  const best = topMoves[1];
  const maxAbs = best && best.score?.type === 'cp'
    ? Math.max(1, Math.abs(best.score.value))
    : 1;

  container.innerHTML = keys.map((k, idx) => {
    const m      = topMoves[k];
    const isBest = idx === 0;
    const sc     = m.score;
    const scoreText  = formatScore(sc);
    const scoreCls   = scoreColorClass(sc);

    let barPct = 30;
    if (sc?.type === 'cp') {
      barPct = Math.min(98, Math.max(10, Math.round((Math.abs(sc.value) / maxAbs) * 98)));
    } else if (sc?.type === 'mate') {
      barPct = 98;
    }

    return `
      <div class="move-card ${isBest ? 'best-move' : ''}"
           onclick="previewMove('${m.from}','${m.to}','${m.uci}')"
           role="button"
           aria-label="${m.san} hamlesini tahtada göster">
        <div class="move-bg-bar" style="width:${barPct}%"></div>
        <span class="move-rank">${isBest ? '★' : k + '.'}</span>
        <span class="move-san">${m.san}</span>
        <span class="move-uci">${m.from}${m.to}</span>
        <span class="move-score ${scoreCls}">${scoreText}</span>
      </div>`;
  }).join('');
}

function formatScore(score) {
  if (!score) return '?';
  if (score.type === 'mate') {
    if (score.value === 0) return 'Mat';
    const sign = score.value > 0 ? '+' : '';
    return `M${sign}${score.value}`;
  }
  const val  = score.value / 100;
  const sign = val >= 0 ? '+' : '';
  return `${sign}${val.toFixed(2)}`;
}

function scoreColorClass(score) {
  if (!score) return 'neutral';
  if (score.type === 'mate') return 'mate';
  if (score.value >  30) return 'positive';
  if (score.value < -30) return 'negative';
  return 'neutral';
}


// ── EVAL BAR ──────────────────────────────────────────────────
function updateEvalBar(score) {
  const fill  = document.getElementById('eval-fill');
  const label = document.getElementById('eval-label');
  const wrap  = document.getElementById('eval-bar-wrap');

  wrap.style.display = 'flex';
  let pct = 50; 

  if (score.type === 'mate') {
    pct = score.value > 0 ? 95 : 5;
    label.textContent = score.value > 0 ? '+Mat' : '−Mat';
  } else {
    const t = Math.tanh(score.value / 400);
    pct = 50 + t * 45; 
    const val = score.value / 100;
    const sign = val >= 0 ? '+' : '';
    label.textContent = `${sign}${val.toFixed(2)}`;
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
  const moveObj  = tempGame.move({
    from, to,
    promotion: uci[4] || 'q'
  });

  if (moveObj) {
    board.position(tempGame.fen(), true);
    showToast(`${from}→${to} önizlemesi (2sn)`, 'ok');
  }

  previewTimer = setTimeout(() => {
    board.position(currentFen, true);
    clearHighlights();
  }, 2500);
}

function clearHighlights() {
  $('[data-square]').removeClass('highlight-from highlight-to');
}


// ── PGN PARSING & BOARD UPDATE ────────────────────────────────
function loadAndAnalyze() {
  const raw = document.getElementById('pgn-input').value.trim();
  if (!raw) {
    showToast('PGN alanı boş!', 'error');
    return;
  }

  let g = new Chess();
  let ok = g.load_pgn(raw);
  if (!ok) {
    g  = new Chess();
    ok = g.load_pgn(raw, { sloppy: true });
  }
  if (!ok) {
    g  = new Chess();
    ok = g.load(raw);
    if (!ok) {
      showToast('Geçersiz PGN! Chess.com\'dan doğru kopyala.', 'error');
      return;
    }
  }

  game = g;
  const fen      = game.fen();
  const history  = game.history();
  const halfMove = history.length;
  const fullMove = Math.ceil(halfMove / 2);
  const turn     = game.turn(); 
  const header   = game.header();

  board.resize();
  board.position(fen, true);

  const turnText = turn === 'w' ? '⬜ Beyaz hamlesi' : '⬛ Siyah hamlesi';
  document.getElementById('turn-pill').textContent = turnText;
  document.getElementById('meta-count').textContent =
    fullMove > 0 ? `${fullMove}. hamle tamamlandı` : '';

  if (header.White && header.Black) {
    showToast(`${header.White} vs ${header.Black}`, 'ok');
  }

  startAnalysis(fen, turn);
}


// ── RESET ─────────────────────────────────────────────────────
function resetApp() {
  if (stockfish && isAnalyzing) stockfish.postMessage('stop');
  isAnalyzing = false;

  document.getElementById('pgn-input').value = '';
  board.position('start');
  currentFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  document.getElementById('turn-pill').textContent  = 'Başlangıç pozisyonu';
  document.getElementById('meta-count').textContent = '';
  document.getElementById('moves-container').innerHTML = `
    <div class="placeholder">
      <span class="placeholder-icon">⟳</span>
      <p>PGN yapıştır ve Analiz Et'e bas</p>
    </div>`;
  document.getElementById('engine-dot').className = 'engine-dot';
  document.getElementById('depth-chip').textContent = '—';
  document.getElementById('eval-bar-wrap').style.display = 'none';
  document.getElementById('analyze-btn').disabled = false;
  document.getElementById('analyze-btn').classList.remove('loading');

  topMoves = {};
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


// ── EVENT BINDINGS ────────────────────────────────────────────
function bindEvents() {
  document.getElementById('analyze-btn')
    .addEventListener('click', loadAndAnalyze);

  document.getElementById('clear-btn')
    .addEventListener('click', resetApp);

  document.getElementById('pgn-input')
    .addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 'Enter') loadAndAnalyze();
    });

  document.getElementById('flip-btn')
    .addEventListener('click', () => {
      board.flip();
      const btn = document.getElementById('flip-btn');
      btn.classList.toggle('flipped');
    });
}
