/* ================================================================
   ChessLens — script.js
   Client-side PGN analyzer with Single-File Stockfish (ASM.js)
   ================================================================ */

'use strict';

// ── STATE ──────────────────────────────────────────────────────
let board        = null;   // chessboard.js instance
let game         = null;   // chess.js instance
let stockfish    = null;   // Web Worker
let sfReady      = false;  // engine ready flag
let isAnalyzing  = false;

let currentFen  = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
let currentTurn = 'w';     // cached turn for score inversion

let topMoves    = {};      // { 1: moveObj, 2: moveObj, 3: moveObj }
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
// WebAssembly (.wasm) dosyası Blob içinde kaybolduğu için, 
// her şeyi tek bir dosyada barındıran ASM.js versiyonunu çekiyoruz.

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

      // Kodu sanal bir Worker içine alıp ateşliyoruz
      const blob = new Blob([code], { type: 'application/javascript' });
      const worker = new Worker(URL.createObjectURL(blob));

      // 15 saniye içinde uyanmazsa işlemi kes
      const readyTimeout = setTimeout(() => {
        if (!sfReady) {
          console.error('[ChessLens] readyok zaman aşımı!');
          worker.terminate();
          setStatus('error');
          showToast('Motor başlatılamadı', 'error');
        }
      }, 15000);

      worker.onmessage = (e) => {
        // Motor uyandıysa sayacı durdur
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

      // Motoru çalışmaya zorla
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

// Durum güncelleyici
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
  // Motor hazır
  if (line === 'readyok') {
    sfReady = true;
    setStatus('ready');
    return;
  }

  // Analiz bitti
  if (line.startsWith('bestmove')) {
    finalizeAnalysis();
    return;
  }

  // Canlı bilgi akışı
  if (!line.startsWith('info')) return;

  const depth   = extractInt(line, /\bdepth (\d+)/);
  const multipv = extractInt(line, /\bmultipv (\d+)/);
  const pvMove  = extractStr(line, /\bpv ([a-h][1-8][a-h][1-8][qrbn]?)/);

  if (depth === null || multipv === null || !pvMove) return;
  if (depth < 5) return; // Düşük derinlikleri atla

  bestDepth = Math.max(bestDepth, depth);

  // Skor hesaplama
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

  // UCI formatını SAN formatına çevir
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

  // Arayüzü canlı güncelle
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
  const label = document.
