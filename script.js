// ── STOCKFISH WORKER ──────────────────────────────────────────
// Motoru dışa bağımlı olmadan, doğrudan kendi klasörümüzden başlatıyoruz.

function initStockfish() {
  setStatus('loading');
  document.getElementById('status-text').textContent = 'Başlatılıyor…';

  // Kendi projemizdeki dosyayı çağırıyoruz. Sıfır CORS hatası, tam performans.
  const worker = new Worker('worker.js');

  worker.onmessage = (e) => {
    handleSFMessage(e.data);
  };

  worker.onerror = (e) => {
    console.error('[ChessLens] Worker başlatılamadı:', e);
    setStatus('error');
    showToast('Motor çalışamadı. stockfish.js dosyası aynı klasörde mi?', 'error');
  };

  stockfish = worker;

  stockfish.postMessage('uci');
  stockfish.postMessage('setoption name MultiPV value 3');
  stockfish.postMessage('setoption name Threads value 1');
  stockfish.postMessage('setoption name Hash value 32');
  stockfish.postMessage('isready');
}
