// ─── State ───────────────────────────────────────────────────────────────────
let currentPage = BigInt(0);
let gridSize = 8;
let renderGeneration = 0; // cancel stale renders
let modalSeed = null;

// ─── DOM References ───────────────────────────────────────────────────────────
const cosmos = document.getElementById('cosmos');
const imageGrid = document.getElementById('imageGrid');
const pageCounter = document.getElementById('pageCounter');
const totalCount = document.getElementById('totalCount');
const addressInput = document.getElementById('addressInput');
const modalOverlay = document.getElementById('modalOverlay');
const modalCanvas = document.getElementById('modalCanvas');
const modalInfo = document.getElementById('modalInfo');
const modalAddr = document.getElementById('modalAddr');

// Grid count adapts to resolution for perf
function perPage() {
  if (gridSize <= 16)  return 24;
  if (gridSize <= 32)  return 16;
  if (gridSize <= 64)  return 12;
  if (gridSize <= 128) return 6;
  return 4; // 256
}

// Grid min-size adapts
function gridMinSize() {
  if (gridSize <= 16)  return 140;
  if (gridSize <= 32)  return 160;
  if (gridSize <= 64)  return 200;
  if (gridSize <= 128) return 240;
  return 280;
}

// ─── Stars ───────────────────────────────────────────────────────────────────
function initStars() {
  for (let i = 0; i < 120; i++) {
    const s = document.createElement('div');
    s.className = 'star';
    s.style.cssText = `left:${Math.random()*100}%;top:${Math.random()*100}%;--d:${3+Math.random()*5}s;--delay:${Math.random()*4}s;width:${Math.random()<0.1?2:1}px;height:${Math.random()<0.1?2:1}px;`;
    cosmos.appendChild(s);
  }
}

// ─── PRNG: Splitmix64 Extended (BigInt-based) ─────────────────────────────────
// Works with arbitrary BigInt seeds for full coverage
function splitmix64(state) {
  state = state + BigInt("0x9e3779b97f4a7c15");
  let z = state;
  z = BigInt.asUintN(64, z);  // Ensure proper 64-bit wrapping
  z = (z ^ (z >> 30n)) * BigInt("0xbf58476d1ce4e5b9");
  z = BigInt.asUintN(64, z);
  z = z ^ (z >> 27n);
  z = (z * BigInt("0x94d049bb133111eb"));
  z = BigInt.asUintN(64, z);
  z = z ^ (z >> 31n);
  z = BigInt.asUintN(64, z);
  return z;
}

// ─── Seed normalization ────────────────────────────────────────────────────────
// Normalize seed to minimum 64 bits for PRNG state initialization
function normalizeSeed(seed) {
  // Ensure seed is a positive BigInt
  if (seed < 0n) seed = -seed;
  return seed;
}

// ─── Text/number → BigInt seed ────────────────────────────────────────────────
function textToSeed(text) {
  text = text.trim();
  // Positive integers
  if (/^\d+$/.test(text)) {
    try { return BigInt(text); } catch(e) {}
  }
  // Hash text into BigInt (no fixed bit limit)
  let h = BigInt(0);
  for (let i = 0; i < text.length; i++) {
    h = (h << 7n) + BigInt(text.charCodeAt(i));
  }
  return h;
}

// ─── Draw pixels onto canvas using Splitmix64 PRNG ─────────────────────────────
// Uses full BigInt seed for complete image space coverage
function drawToCanvas(canvas, seed, size) {
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(size, size);
  const data = imageData.data;
  const n = size * size;

  let currentSeed = normalizeSeed(seed);
  let state = 0n;

  // Fast extraction for massive BigInts to prevent UI freeze
  const hexStr = currentSeed.toString(16);
  const len = hexStr.length;

  // Generate pixels: advance state sequentially to prevent overlapping images
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    // Extract 24 bits (6 hex chars) from the arbitrary BigInt seed
    const end = Math.max(0, len - i * 6);
    const start = Math.max(0, len - (i + 1) * 6);
    const chunk = start < end ? hexStr.slice(start, end) : '0';
    const seedChunk = BigInt('0x' + chunk);

    // Mix seed chunk and pixel index into state to prevent pixel-shifting bug
    // and to incorporate the entire arbitrary length seed.
    state = state ^ seedChunk ^ BigInt(i);
    state = splitmix64(state);

    // Extract 24 bits (3 bytes) for RGB
    const lo = Number(state & 0xFFFFFFn);
    data[p]     = lo & 0xFF;
    data[p + 1] = (lo >> 8) & 0xFF;
    data[p + 2] = (lo >> 16) & 0xFF;
    data[p + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
}

// ─── Seed math ────────────────────────────────────────────────────────────────
function pageStartSeed() {
  return currentPage * BigInt(perPage());
}

function updateTotalCount() {
  const exp = gridSize * gridSize * 3;
  totalCount.textContent = `256^${exp} ≈ 10^${Math.floor(exp * Math.log10(256))}`;
}

// ─── Render grid (async, frame-chunked) ──────────────────────────────────────
function renderGrid() {
  const gen = ++renderGeneration;
  imageGrid.innerHTML = '';
  imageGrid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${gridMinSize()}px, 1fr))`;
  const start = pageStartSeed();
  const count = perPage();
  updateTotalCount();

  pageCounter.textContent = `Page ${formatPageNumber((currentPage + 1n).toString())} · ${gridSize}×${gridSize}px`;

  // Pre-create all card DOM immediately (shows structure fast)
  const cards = [];
  for (let i = 0; i < count; i++) {
    const seed = start + BigInt(i);
    const card = document.createElement('div');
    card.className = 'image-card loading';
    const wrap = document.createElement('div');
    wrap.className = 'canvas-wrap';
    wrap.style.background = '#0a0806';
    const canvas = document.createElement('canvas');
    canvas.width = 1; canvas.height = 1; // placeholder
    const addr = document.createElement('div');
    addr.className = 'card-addr';
    const s = seed.toString();
    addr.textContent = formatAddress(s);
    wrap.appendChild(canvas);
    card.appendChild(wrap);
    card.appendChild(addr);
    card.addEventListener('click', () => openModal(seed));
    imageGrid.appendChild(card);
    cards.push({ card, canvas, seed });
  }

  // Render canvases in batches across animation frames to stay responsive
  const BATCH = gridSize >= 128 ? 1 : gridSize >= 64 ? 2 : 4;
  let idx = 0;

  function renderBatch() {
    if (gen !== renderGeneration) return; // stale — abort
    const end = Math.min(idx + BATCH, cards.length);
    for (let j = idx; j < end; j++) {
      const { card, canvas, seed } = cards[j];
      drawToCanvas(canvas, seed, gridSize);
      card.classList.remove('loading');
    }
    idx = end;
    if (idx < cards.length) requestAnimationFrame(renderBatch);
  }
  requestAnimationFrame(renderBatch);
}

// ─── Format helpers ──────────────────────────────────────────────────────────
function formatAddress(addr) {
  if (addr.length <= 18) return addr;
  return addr.slice(0, 9) + '…' + addr.slice(-8);
}

function formatPageNumber(num) {
  if (num.length <= 12) return num;
  return num.slice(0, 6) + '…' + num.slice(-5);
}

// ─── Navigation ──────────────────────────────────────────────────────────────
function nextPage() { currentPage++; renderGrid(); scrollToGallery(); }

function prevPage() {
  if (currentPage > 0n) { currentPage--; renderGrid(); scrollToGallery(); }
}

function scrollToGallery() {
  imageGrid.scrollIntoView({behavior:'smooth', block:'start'});
}

function randomPage() {
  // Generate a very large random BigInt for full coverage
  const bytes = gridSize * gridSize * 3;
  const hexChars = bytes * 2;
  const hex = '0x' + Array.from({length: hexChars}, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const seed = BigInt(hex);
  currentPage = seed / BigInt(perPage());
  renderGrid();
}

function seekImage() {
  const val = addressInput.value.trim();
  if (!val) return;
  const seed = textToSeed(val);
  currentPage = seed / BigInt(perPage());
  renderGrid();
  setTimeout(() => {
    const idx = Number(seed % BigInt(perPage()));
    if (imageGrid.children[idx]) {
      imageGrid.children[idx].style.outline = '2px solid rgba(196,75,30,0.8)';
      imageGrid.children[idx].style.outlineOffset = '3px';
      imageGrid.children[idx].scrollIntoView({behavior:'smooth', block:'nearest'});
    }
  }, 100);
}

function setSize(size, btn) {
  document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  gridSize = size;
  currentPage = 0n;
  renderGrid();
}

// ─── Modal ───────────────────────────────────────────────────────────────────
function openModal(seed) {
  modalSeed = seed;
  drawToCanvas(modalCanvas, seed, gridSize);
  modalCanvas.style.width = '280px';
  modalCanvas.style.height = '280px';
  const seedStr = seed.toString();
  modalInfo.innerHTML = `
    <div><strong>Address:</strong> ${seedStr.length > 20 ? seedStr.slice(0,20)+'…' : seedStr}</div>
    <div><strong>Resolution:</strong> ${gridSize}×${gridSize} pixels</div>
    <div><strong>Total Pixels:</strong> ${gridSize*gridSize}</div>
    <div><strong>Color Depth:</strong> 24-bit RGB</div>
  `;
  modalAddr.innerHTML = `
    <span>Full Address (this image's exact location in the library)</span>${seedStr}
  `;
  modalOverlay.classList.add('open');
}

function closeModal(e) {
  if (e.target === modalOverlay) closeModalDirect();
}

function closeModalDirect() {
  modalOverlay.classList.remove('open');
}

function copyAddress() {
  if (modalSeed !== null) {
    navigator.clipboard.writeText(modalSeed.toString()).then(() => {
      const btn = document.getElementById('copyAddrBtn');
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy Address', 1500);
    });
  }
}

function downloadModal() {
  if (modalSeed === null) return;
  const a = document.createElement('a');
  a.href = modalCanvas.toDataURL('image/png');
  a.download = `library-${gridSize}x${gridSize}-${modalSeed.toString().slice(0,12)}.png`;
  a.click();
}

// ─── Event Listeners ─────────────────────────────────────────────────────────
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModalDirect(); });
addressInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') seekImage();
});
modalOverlay.addEventListener('click', closeModal);

// Button event listeners
document.getElementById('seekBtn').addEventListener('click', seekImage);
document.getElementById('randomBtn').addEventListener('click', randomPage);
document.getElementById('prevBtnTop').addEventListener('click', prevPage);
document.getElementById('nextBtnTop').addEventListener('click', nextPage);
document.getElementById('prevBtnBottom').addEventListener('click', prevPage);
document.getElementById('nextBtnBottom').addEventListener('click', nextPage);
document.getElementById('modalCloseBtn').addEventListener('click', closeModalDirect);
document.getElementById('copyAddrBtn').addEventListener('click', copyAddress);
document.getElementById('downloadBtn').addEventListener('click', downloadModal);

// Size selector
document.querySelectorAll('.size-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    setSize(parseInt(this.dataset.size), this);
  });
});

// ─── Init ─────────────────────────────────────────────────────────────────────
initStars();
renderGrid();
