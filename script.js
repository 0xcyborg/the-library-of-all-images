// ─── State ───────────────────────────────────────────────────────────────────
let currentPage = '0'; // Hex string
let gridSize = 8;
let renderGeneration = 0; 
let modalSeed = null;
let seekRunning = false; // Guard against concurrent seekImage() invocations

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

// ─── Hex String Math (Chunk-based to avoid BigInt allocation limits) ─────────
function hexAdd(h1, h2) {
  const s1 = h1 || '0';
  const s2 = typeof h2 === 'string' ? h2 : BigInt(h2).toString(16);
  const len = Math.max(s1.length, s2.length);
  const a = s1.padStart(len, '0');
  const b = s2.padStart(len, '0');
  let res = '';
  let carry = 0n;
  for (let i = len; i > 0; i -= 12) {
    const start = Math.max(0, i - 12);
    const chunkLen = i - start;
    const val = BigInt("0x" + a.slice(start, i)) + BigInt("0x" + b.slice(start, i)) + carry;
    const s = val.toString(16);
    if (s.length > chunkLen) {
      if (start > 0) {
        // Interior chunk: carry the overflow to the next iteration
        res = s.slice(-chunkLen) + res;
        carry = BigInt("0x" + s.slice(0, -chunkLen));
      } else {
        // Leftmost chunk: prepend the full overflowed value directly
        res = s + res;
        carry = 0n;
      }
    } else {
      res = s.padStart(start > 0 ? chunkLen : 0, '0') + res;
      carry = 0n;
    }
  }
  if (carry > 0n) res = carry.toString(16) + res;
  return res.replace(/^0+(?=.)/, '') || '0';
}

function hexSub(hex, n) {
  if (n === 0) return hex;
  let res = '';
  let borrow = BigInt(n);
  for (let i = hex.length; i > 0; i -= 12) {
    const start = Math.max(0, i - 12);
    const part = hex.slice(start, i);
    let val = BigInt("0x" + part) - borrow;
    if (val < 0n) {
      if (start > 0) {
        const unit = 1n << BigInt(part.length * 4);
        val += unit;
        borrow = 1n;
      } else {
        return '0'; // underflow guard: result would be negative
      }
    } else {
      borrow = 0n;
    }
    res = val.toString(16).padStart(part.length, '0') + res;
  }
  return res.replace(/^0+(?=.)/, '') || '0';
}

function hexMul(hex, n) {
  if (n === 0 || n === 0n || n === '0') return '0';
  let s2 = typeof n === 'string' ? n : BigInt(n).toString(16);
  // Fast path: s2 fits in one 48-bit chunk — use chunked multiplier
  if (s2.length <= 12) {
    let carry = 0n;
    const m = BigInt("0x" + s2);
    let out = '';
    for (let i = hex.length; i > 0; i -= 12) {
      const start = Math.max(0, i - 12);
      const part = hex.slice(start, i);
      const val = BigInt("0x" + part) * m + carry;
      const s = val.toString(16);
      if (s.length > part.length && start > 0) {
        out = s.slice(-part.length).padStart(part.length, '0') + out;
        carry = BigInt("0x" + s.slice(0, -part.length));
      } else {
        out = s.padStart(part.length, '0') + out;
        carry = 0n;
      }
    }
    if (carry > 0n) out = carry.toString(16) + out;
    return out.replace(/^0+(?=.)/, '') || '0';
  }
  // General case: schoolbook multiplication for two large hex strings.
  // Split s2 into 12-char chunks and sum shifted partial products.
  let acc = '0';
  for (let i = 0; i < s2.length; i += 12) {
    const part = s2.slice(i, i + 12);
    const partial = hexMul(hex, part); // part <= 12 chars, hits fast path
    const trailingZeros = s2.length - i - part.length; // hex digit shift
    const shifted = partial + '0'.repeat(trailingZeros);
    acc = hexAdd(acc, shifted);
  }
  return acc;
}

function hexDiv(hex, n) {
  if (n === 1) return hex;
  let res = '';
  let rem = 0n;
  const d = BigInt(n);
  for (let i = 0; i < hex.length; i += 12) {
    const part = hex.slice(i, i + 12);
    const val = (rem << BigInt(part.length * 4)) + BigInt("0x" + part);
    // Pad each non-first chunk to exactly part.length digits (its positional contribution)
    res += (val / d).toString(16).padStart(i === 0 ? 0 : part.length, '0');
    rem = val % d;
  }
  return res.replace(/^0+(?=.)/, '') || '0';
}

function hexMod(hex, n) {
  let rem = 0n;
  const d = BigInt(n);
  for (let i = 0; i < hex.length; i += 12) {
    const part = hex.slice(i, i + 12);
    const val = (rem << BigInt(part.length * 4)) + BigInt("0x" + part);
    rem = val % d;
  }
  return Number(rem);
}

// Compare two hex strings: returns -1, 0, or 1
function hexCompare(a, b) {
  a = (a || '0').replace(/^0+/, '') || '0';
  b = (b || '0').replace(/^0+/, '') || '0';
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// Maximum valid seed for the current grid: 256^(N²×3) − 1 = 'ff' × N²×3
function maxSeedHex() {
  return 'f'.repeat(gridSize * gridSize * 3 * 2);
}

// ─── Seed normalization ────────────────────────────────────────────────────────
function normalizeSeed(seed) {
  if (typeof seed === 'string') return seed.replace(/^0x/, '');
  return seed.toString(16);
}

// Compute 10^exp as a hex string without allocating a huge BigInt
function hexPow10(exp) {
  if (exp < 100000) return (10n ** BigInt(exp)).toString(16);
  // Recursive: 10^exp = 10^(exp/2) * 10^(exp - exp/2)
  const half = Math.floor(exp / 2);
  const lo = hexPow10(half);
  const hi = hexPow10(exp - half);
  return hexMul(lo, hi);
}

async function decimalToHex(dec) {
  if (dec.length < 100000) {
    try { return BigInt(dec).toString(16); } catch (e) {}
  }
  // Yield for UI responsiveness
  if (dec.length > 500000) await new Promise(r => setTimeout(r, 0));
  
  const mid = Math.floor(dec.length / 2);
  const hi = await decimalToHex(dec.slice(0, mid));
  const lo = await decimalToHex(dec.slice(mid));
  // Use hexPow10 to avoid creating a huge BigInt for the multiplier
  const multiplier = hexPow10(dec.length - mid);
  return hexAdd(hexMul(hi, multiplier), lo);
}

// ─── Text/number → Hex Address ────────────────────────────────────────────────
async function textToHex(text) {
  text = text.trim();
  if (/^\d+$/.test(text)) return await decimalToHex(text);
  if (/^0x[0-9a-fA-F]+$/i.test(text)) return text.slice(2).toLowerCase();
  // Bare hex string (no 0x prefix but only hex chars, with at least one a-f)
  // This handles copy-pasted addresses from the card labels.
  if (/^[0-9a-fA-F]+$/i.test(text) && /[a-fA-F]/.test(text)) return text.toLowerCase();
  
  if (text.length < 100000) {
    // No try/catch: if an error occurs here it must propagate, not silently fall
    // through to the recursive path which uses a different algorithm and would
    // produce a different address for the same input, breaking determinism.
    let h = 0n;
    for (let i = 0; i < text.length; i++) h = (h << 7n) + BigInt(text.charCodeAt(i));
    return h.toString(16);
  }

  // Yield for UI responsiveness
  if (text.length > 500000) await new Promise(r => setTimeout(r, 0));

  const mid = Math.floor(text.length / 2);
  const hi = await textToHex(text.slice(0, mid));
  const lo = await textToHex(text.slice(mid));
  
  const bits = (text.length - mid) * 7;
  const hexShift = Math.floor(bits / 4);
  const bitRem = bits % 4;
  
  let shiftedHi = hi;
  if (bitRem > 0) {
    shiftedHi = hexMul(hi, 1 << bitRem);
  }
  const res = shiftedHi + '0'.repeat(hexShift);
  return hexAdd(res, lo);
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

  let hexStr = normalizeSeed(seed);
  let len = hexStr.length;
  let state = 0n;

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const end = Math.max(0, len - i * 6);
    const start = Math.max(0, len - (i + 1) * 6);
    const chunk = start < end ? hexStr.slice(start, end) : '0';
    const seedChunk = BigInt('0x' + chunk);

    state = state ^ seedChunk ^ BigInt(i);
    state = splitmix64(state);

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
  return hexMul(currentPage, perPage());
}

function updateTotalCount() {
  const exp = gridSize * gridSize * 3;
  totalCount.textContent = `256^${exp} ≈ 10^${Math.floor(exp * Math.log10(256))}`;
}

// ─── Render grid (async, frame-chunked) ──────────────────────────────────────
function renderGrid() {
  return new Promise(resolve => {
    const gen = ++renderGeneration;
    imageGrid.innerHTML = '';
    imageGrid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${gridMinSize()}px, 1fr))`;
    const start = pageStartSeed();
    const count = perPage();
    updateTotalCount();

    pageCounter.textContent = `Page ${formatPageNumber(hexAdd(currentPage, 1))} · ${gridSize}×${gridSize}px`;

    const cards = [];
    for (let i = 0; i < count; i++) {
      const seed = hexAdd(start, i);
      const card = document.createElement('div');
      card.className = 'image-card loading';
      const wrap = document.createElement('div');
      wrap.className = 'canvas-wrap';
      wrap.style.background = '#0a0806';
      const canvas = document.createElement('canvas');
      canvas.width = 1; canvas.height = 1; 
      const addr = document.createElement('div');
      addr.className = 'card-addr';
      addr.textContent = formatAddress(seed);
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
      if (gen !== renderGeneration) {
        resolve(); // stale — abort
        return;
      }
      const end = Math.min(idx + BATCH, cards.length);
      for (let j = idx; j < end; j++) {
        const { card, canvas, seed } = cards[j];
        drawToCanvas(canvas, seed, gridSize);
        card.classList.remove('loading');
      }
      idx = end;
      if (idx < cards.length) requestAnimationFrame(renderBatch);
      else resolve();
    }
    requestAnimationFrame(renderBatch);
  });
}

// ─── Format helpers ──────────────────────────────────────────────────────────
function formatAddress(addr) {
  const full = '0x' + addr;
  if (full.length <= 20) return full;
  return full.slice(0, 10) + '\u2026' + full.slice(-8);
}

function formatPageNumber(num) {
  if (num.length <= 12) return num;
  return num.slice(0, 6) + '…' + num.slice(-5);
}

// ─── Navigation ──────────────────────────────────────────────────────────────
function nextPage() { currentPage = hexAdd(currentPage, 1); renderGrid(); scrollToGallery(); }

function prevPage() {
  if (currentPage !== '0' && currentPage !== '') { 
    currentPage = hexSub(currentPage, 1); 
    renderGrid(); 
    scrollToGallery(); 
  }
}

function scrollToGallery() {
  imageGrid.scrollIntoView({behavior:'smooth', block:'start'});
}

async function randomPage() {
  const btn = document.getElementById('randomBtn');
  const overlay = document.getElementById('statusOverlay');
  btn.classList.add('loading-btn');
  overlay.classList.add('active');
  try {
    await new Promise(r => setTimeout(r, 100));
    const bytes = gridSize * gridSize * 3;
    const hexChars = bytes * 2;
    const hex = Array.from({length: hexChars}, () => Math.floor(Math.random() * 16).toString(16)).join('');
    currentPage = hexDiv(hex, perPage());
    await renderGrid();
  } finally {
    btn.classList.remove('loading-btn');
    overlay.classList.remove('active');
  }
}

function showToast(msg, type = 'error') {
  let toast = document.getElementById('libToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'libToast';
    toast.style.cssText = [
      'position:fixed',
      'top:28px',
      'left:50%',
      'transform:translateX(-50%) translateY(-120%)',
      'z-index:9999',
      'min-width:320px',
      'max-width:90vw',
      'padding:14px 24px',
      'border-radius:12px',
      'font-family:Space Mono,monospace',
      'font-size:0.82rem',
      'line-height:1.5',
      'text-align:center',
      'pointer-events:none',
      'transition:transform 0.35s cubic-bezier(.22,1,.36,1), opacity 0.35s ease',
      'opacity:0',
      'box-shadow:0 8px 40px rgba(0,0,0,0.6)',
    ].join(';');
    document.body.appendChild(toast);
  }
  const isError = type === 'error';
  toast.style.background = isError
    ? 'linear-gradient(135deg,#3a0a0a 0%,#1e0505 100%)'
    : 'linear-gradient(135deg,#0a2a1a 0%,#051a0a 100%)';
  toast.style.border = `1px solid ${isError ? 'rgba(255,80,80,0.45)' : 'rgba(80,255,140,0.35)'}`;
  toast.style.color = isError ? '#ff8a8a' : '#7dffb0';
  toast.innerHTML = `<span style="font-size:1.1em;margin-right:8px">${isError ? '⚠' : '✓'}</span>${msg}`;

  // Slide in
  requestAnimationFrame(() => {
    toast.style.transform = 'translateX(-50%) translateY(0)';
    toast.style.opacity = '1';
  });

  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    toast.style.transform = 'translateX(-50%) translateY(-120%)';
    toast.style.opacity = '0';
  }, 4000);
}

async function seekImage() {
  const val = addressInput.value.trim();
  if (!val || seekRunning) return; // Ignore rapid re-invocations
  seekRunning = true;
  const btn = document.getElementById('seekBtn');
  const overlay = document.getElementById('statusOverlay');
  btn.classList.add('loading-btn');
  overlay.classList.add('active');
  try {
    await new Promise(r => setTimeout(r, 100));
    const seed = await textToHex(val);
    const max = maxSeedHex();
    if (hexCompare(seed, max) > 0) {
      showToast(`Address exceeds the ${gridSize}×${gridSize} library space — max is ${gridSize*gridSize*3*2} hex digits.`);
      scrollToGallery();
      return;
    }
    currentPage = hexDiv(seed, perPage());
    await renderGrid();
    const idx = hexMod(seed, perPage());
    if (imageGrid.children[idx]) {
      imageGrid.children[idx].style.outline = '2px solid rgba(196,75,30,0.8)';
      imageGrid.children[idx].style.outlineOffset = '3px';
      imageGrid.children[idx].scrollIntoView({behavior:'smooth', block:'nearest'});
    }
  } finally {
    seekRunning = false;
    btn.classList.remove('loading-btn');
    overlay.classList.remove('active');
  }
}

function setSize(size, btn) {
  document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  gridSize = size;
  currentPage = '0';
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
    // Prefix with 0x so the address round-trips correctly through the search box
    navigator.clipboard.writeText('0x' + modalSeed.toString()).then(() => {
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
