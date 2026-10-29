/*
 * Vocab Break Reader - SillyTavern Extension
 * 小说阅读小窗（章节版 · 阅读进度保存修复版）
 *
 * 相比上一版的修复点：
 * 1. 面板关闭 / 切换书籍前，先 flush 位置，再隐藏或换内容（避免 display:none 后 scrollTop 归零被误存）。
 * 2. 滚动时即时把 scrollTop 记到内存，防抖只用于落盘；syncReaderProgress 只认 savedScrollTop，不再被 pending 覆盖。
 * 3. 正文渲染加入渲染指纹，内容/章节/字号没变就不重建 DOM，滚动位置自然保留。
 * 4. 章节内滚动位置、所属章节一起持久化，切换书籍后可完整回到原位置。
 */

import { getContext } from '/scripts/extensions.js';
import { getStringHash } from '/scripts/utils.js';

const MODULE_NAME = 'vocab-break';
const STORAGE_PREFIX = 'vocab-break';

const REMOTE_SOURCES = [
  {
    id: 'openstax-econ',
    label: '经济学（OpenStax · CC BY）',
    indexUrl: 'https://raw.githubusercontent.com/philschatz/economics-book/master/SUMMARY.md',
    chapterPrefix: 'https://raw.githubusercontent.com/philschatz/economics-book/master/contents/',
    type: 'summary-md',
  },
];

const DEFAULT_CONFIG = {
  enableReader: true,
  theme: 'minimal',
  customCss: '',
  settingsOpen: false,
  panelPos: null,
  barPos: null,
  readerPanelWidth: 360,
  readerPanelHeight: 520,
  readerRemoteSourceId: 'openstax-econ',
  readerRemoteChapterUrl: '',
  readerCacheMaxBytes: 32 * 1024 * 1024,
  readerFontSize: 14,
  readerLineHeight: 1.6,
  readerParagraphSpacing: 16,
  readerEncoding: 'auto',
  readerKeepScroll: true,
};

const READER_CONTENT_KEY = `${STORAGE_PREFIX}:reader:content`;
const READER_META_KEY = `${STORAGE_PREFIX}:reader:meta`;
const READER_DB_NAME = `${STORAGE_PREFIX}:reader-db`;
const READER_DB_STORE = 'reader';
const READER_CONTENT_IDB_KEY = 'content';
const READER_META_IDB_KEY = 'meta';
const READER_LIBRARY_INDEX_KEY = 'library:index';
const READER_LIBRARY_ITEM_PREFIX = 'library:item:';
const READER_LIBRARY_MAX_ITEMS = 20;
const READER_BOOKMARKS_KEY = `${STORAGE_PREFIX}:reader:bookmarks`;
const THEME_PREFIX = 'vb-theme-';
const CUSTOM_STYLE_ID = 'vocab-break-custom-style';
const DRAG_MARGIN = 6;
const PROGRESS_SAVE_DELAY = 300;

const TEXT_ENCODINGS = [
  { id: 'auto', label: '自动识别' },
  { id: 'utf-8', label: 'UTF-8' },
  { id: 'gbk', label: 'GBK' },
  { id: 'big5', label: 'Big5' },
  { id: 'utf-16le', label: 'UTF-16LE' },
  { id: 'utf-16be', label: 'UTF-16BE' },
];

const PDFJS_CDN_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const JSZIP_CDN_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';

let pluginConfig = { ...DEFAULT_CONFIG };

let readerRemotePopoverOpen = false;
let readerLibraryPopoverOpen = false;
let readerBookmarkPopoverOpen = false;
let readerTocPopoverOpen = false;
let readerProgressSaveTimer = null;

/* 正文渲染指纹：内容 / 章节 / 排版都没变时，不重建 DOM，滚动位置才保得住 */
let pageRenderKey = '';

const state = {
  readerPanelOpen: false,
  reader: {
    text: '',
    pages: [],
    chapterTitles: [],
    pageIndex: 0,
    sourceType: 'txt',
    title: '',
    updatedAt: 0,
    cacheDisabled: false,
    /* savedScrollTop：当前章节内的真实滚动位置（内存真相） */
    savedScrollTop: 0,
    /* pendingScrollTop：待应用的滚动位置，null 表示无需应用 */
    pendingScrollTop: null,
    bookKey: '',
    bookTitle: '',
    lastPage: 0,
    maxPage: 0,
    bookmarks: [],
    library: {
      items: [],
      selectedId: '',
      loading: false,
      error: '',
    },
  },
  remote: {
    sourceId: '',
    chapters: [],
    selectedUrl: '',
    loadingIndex: false,
    loadingChapter: false,
    error: '',
    updatedAt: 0,
  },
  drag: {
    active: false,
    offsetX: 0,
    offsetY: 0,
    startX: 0,
    startY: 0,
    moved: false,
    justDragged: false,
    target: '',
  },
};

/* ========================= 配置 ========================= */

function initConfig() {
  const ctx = getContext();
  ctx.extensionSettings = ctx.extensionSettings || {};
  const existing = ctx.extensionSettings[MODULE_NAME] || {};
  pluginConfig = { ...DEFAULT_CONFIG, ...existing };

  pluginConfig.enableReader = typeof pluginConfig.enableReader === 'boolean'
    ? pluginConfig.enableReader
    : DEFAULT_CONFIG.enableReader;

  if (!['minimal', 'archive', 'ancient', 'custom'].includes(pluginConfig.theme)) {
    pluginConfig.theme = DEFAULT_CONFIG.theme;
  }

  pluginConfig.customCss = typeof pluginConfig.customCss === 'string' ? pluginConfig.customCss : '';
  pluginConfig.settingsOpen = typeof pluginConfig.settingsOpen === 'boolean'
    ? pluginConfig.settingsOpen
    : DEFAULT_CONFIG.settingsOpen;

  pluginConfig.readerPanelWidth = Number.isFinite(Number(pluginConfig.readerPanelWidth))
    ? Number(pluginConfig.readerPanelWidth)
    : DEFAULT_CONFIG.readerPanelWidth;
  pluginConfig.readerPanelHeight = Number.isFinite(Number(pluginConfig.readerPanelHeight))
    ? Number(pluginConfig.readerPanelHeight)
    : DEFAULT_CONFIG.readerPanelHeight;

  if (!pluginConfig.panelPos
    || !Number.isFinite(pluginConfig.panelPos.x)
    || !Number.isFinite(pluginConfig.panelPos.y)) {
    pluginConfig.panelPos = DEFAULT_CONFIG.panelPos;
  }
  if (!pluginConfig.barPos
    || !Number.isFinite(pluginConfig.barPos.x)
    || !Number.isFinite(pluginConfig.barPos.y)) {
    pluginConfig.barPos = DEFAULT_CONFIG.barPos;
  }

  pluginConfig.readerCacheMaxBytes = Number.isFinite(Number(pluginConfig.readerCacheMaxBytes))
    ? Number(pluginConfig.readerCacheMaxBytes)
    : DEFAULT_CONFIG.readerCacheMaxBytes;
  pluginConfig.readerFontSize = Number.isFinite(Number(pluginConfig.readerFontSize))
    ? Number(pluginConfig.readerFontSize)
    : DEFAULT_CONFIG.readerFontSize;
  pluginConfig.readerLineHeight = Number.isFinite(Number(pluginConfig.readerLineHeight))
    ? Number(pluginConfig.readerLineHeight)
    : DEFAULT_CONFIG.readerLineHeight;
  pluginConfig.readerParagraphSpacing = Number.isFinite(Number(pluginConfig.readerParagraphSpacing))
    ? Math.max(0, Number(pluginConfig.readerParagraphSpacing))
    : DEFAULT_CONFIG.readerParagraphSpacing;
  pluginConfig.readerKeepScroll = typeof pluginConfig.readerKeepScroll === 'boolean'
    ? pluginConfig.readerKeepScroll
    : DEFAULT_CONFIG.readerKeepScroll;

  if (!TEXT_ENCODINGS.some(encoding => encoding.id === String(pluginConfig.readerEncoding || ''))) {
    pluginConfig.readerEncoding = DEFAULT_CONFIG.readerEncoding;
  }

  if (!REMOTE_SOURCES.some(s => s.id === pluginConfig.readerRemoteSourceId)) {
    pluginConfig.readerRemoteSourceId = DEFAULT_CONFIG.readerRemoteSourceId;
  }

  pluginConfig.readerRemoteChapterUrl = typeof pluginConfig.readerRemoteChapterUrl === 'string'
    ? pluginConfig.readerRemoteChapterUrl
    : '';

  ctx.extensionSettings[MODULE_NAME] = pluginConfig;
}

function saveSettings() {
  const ctx = getContext();
  ctx.extensionSettings[MODULE_NAME] = pluginConfig;
  ctx.saveSettingsDebounced();
}

/* ========================= 通用工具 ========================= */

function getRemoteSource() {
  const id = pluginConfig.readerRemoteSourceId;
  return REMOTE_SOURCES.find(s => s.id === id) || REMOTE_SOURCES[0];
}

function normalizeRemotePath(path, ext) {
  let clean = String(path || '').trim();
  if (!clean) return '';
  if (clean.startsWith('./')) clean = clean.slice(2);
  if (clean.startsWith('/')) clean = clean.slice(1);
  if (ext && !clean.endsWith(ext)) clean += ext;
  return clean;
}

function parseSummaryMarkdown(text, prefix) {
  const items = [];
  const seen = new Set();
  const re = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match = null;
  while ((match = re.exec(text))) {
    const title = match[1]?.trim();
    const rawPath = match[2]?.trim();
    if (!rawPath || !rawPath.includes('contents/')) continue;
    const cleanPath = rawPath.replace(/^.*contents\//, '');
    const url = `${prefix}${cleanPath}`;
    if (seen.has(url)) continue;
    seen.add(url);
    items.push({ title: title || cleanPath, url });
  }
  return items;
}

function extractNotebookText(text) {
  try {
    const json = JSON.parse(text);
    if (!json || !Array.isArray(json.cells)) return text;
    const parts = [];
    for (const cell of json.cells) {
      if (!cell || !Array.isArray(cell.source)) continue;
      const body = cell.source.join('');
      if (!body.trim()) continue;
      if (cell.cell_type === 'code') {
        parts.push(`\n[代码]\n${body}`);
      } else {
        parts.push(body);
      }
    }
    return parts.join('\n\n').trim() || text;
  } catch {
    return text;
  }
}

function getElementSize(el, fallback) {
  const rect = el.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    return { width: rect.width, height: rect.height };
  }
  const prevDisplay = el.style.display;
  const prevVisibility = el.style.visibility;
  el.style.visibility = 'hidden';
  el.style.display = 'flex';
  const tmpRect = el.getBoundingClientRect();
  el.style.display = prevDisplay;
  el.style.visibility = prevVisibility;
  if (tmpRect.width > 0 && tmpRect.height > 0) {
    return { width: tmpRect.width, height: tmpRect.height };
  }
  return fallback;
}

function getPanelSize() {
  return {
    width: Math.max(240, Number(pluginConfig.readerPanelWidth) || 360),
    height: Math.max(320, Number(pluginConfig.readerPanelHeight) || 520),
  };
}

function applyPanelSizing() {
  const panel = document.getElementById('vocab-break-reader-panel');
  if (!panel) return;
  const size = getPanelSize();
  panel.style.width = `${size.width}px`;
  panel.style.height = `${size.height}px`;
}

function clampPosition(x, y, size) {
  const maxX = Math.max(DRAG_MARGIN, window.innerWidth - size.width - DRAG_MARGIN);
  const maxY = Math.max(DRAG_MARGIN, window.innerHeight - size.height - DRAG_MARGIN);
  return {
    x: Math.min(Math.max(DRAG_MARGIN, x), maxX),
    y: Math.min(Math.max(DRAG_MARGIN, y), maxY),
  };
}

function isCompactViewport() {
  return window.innerWidth <= 520 || window.innerHeight <= 520;
}

function ensureDefaultPosition(panel) {
  if (pluginConfig.panelPos) return;
  const size = getElementSize(panel, getPanelSize());
  const x = Math.round((window.innerWidth - size.width) / 2);
  const y = Math.round((window.innerHeight - size.height) / 2);
  pluginConfig.panelPos = clampPosition(x, y, size);
  saveSettings();
}

function applyFloatingPosition(el, pos, fallback) {
  if (!el || !pos) return;
  const size = getElementSize(el, fallback);
  const clamped = clampPosition(pos.x, pos.y, size);
  el.style.left = `${clamped.x}px`;
  el.style.top = `${clamped.y}px`;
  el.style.right = 'auto';
  el.style.bottom = 'auto';
}

function updateBarDocking(bar, pos) {
  if (!bar || !pos) return;
  if (state.drag.active && state.drag.target === bar.id) return;
  const size = getElementSize(bar, { width: 40, height: 40 });
  const dockLeft = pos.x <= DRAG_MARGIN + 2;
  const dockRight = pos.x + size.width >= window.innerWidth - DRAG_MARGIN - 2;
  bar.classList.toggle('vb-docked-left', dockLeft);
  bar.classList.toggle('vb-docked-right', !dockLeft && dockRight);
}

function applyFloatingPositions() {
  const readerPanel = document.getElementById('vocab-break-reader-panel');
  const readerBar = document.getElementById('vocab-break-reader-bar');
  const barFallback = { width: 40, height: 40 };

  if (readerPanel) {
    ensureDefaultPosition(readerPanel);
    if (pluginConfig.panelPos) {
      applyFloatingPosition(readerPanel, pluginConfig.panelPos, getPanelSize());
    }
  }

  if (readerBar) {
    const barPos = pluginConfig.barPos || pluginConfig.panelPos;
    if (barPos) {
      applyFloatingPosition(readerBar, barPos, barFallback);
      updateBarDocking(readerBar, barPos);
    }
  }
}

function ensurePanelInView(panel) {
  if (!panel || !panel.classList.contains('is-open')) return;
  const size = getElementSize(panel, getPanelSize());
  const rect = panel.getBoundingClientRect();
  const isOffscreen = rect.bottom < DRAG_MARGIN
    || rect.top > window.innerHeight - DRAG_MARGIN
    || rect.right < DRAG_MARGIN
    || rect.left > window.innerWidth - DRAG_MARGIN;

  if (isOffscreen) {
    const x = Math.round((window.innerWidth - size.width) / 2);
    const y = Math.round((window.innerHeight - size.height) / 2);
    pluginConfig.panelPos = clampPosition(x, y, size);
    saveSettings();
    applyFloatingPositions();
    return;
  }

  const clamped = clampPosition(rect.left, rect.top, size);
  if (Math.round(clamped.x) !== Math.round(rect.left)
    || Math.round(clamped.y) !== Math.round(rect.top)) {
    pluginConfig.panelPos = clamped;
    saveSettings();
    applyFloatingPositions();
  }
}

/* ========================= 拖拽 ========================= */

function beginDrag(e, targetEl) {
  if (!targetEl) return;
  if (e.button !== 0 && e.pointerType !== 'touch') return;
  if (e.target instanceof HTMLElement) {
    if (e.target.closest('button, select, input, textarea, a')) return;
  }
  const rect = targetEl.getBoundingClientRect();
  if (targetEl.id === 'vocab-break-reader-bar') {
    targetEl.style.left = `${rect.left}px`;
    targetEl.style.right = 'auto';
    targetEl.classList.remove('vb-docked-left', 'vb-docked-right');
  }

  state.drag.active = true;
  state.drag.offsetX = e.clientX - rect.left;
  state.drag.offsetY = e.clientY - rect.top;
  state.drag.startX = e.clientX;
  state.drag.startY = e.clientY;
  state.drag.moved = false;
  state.drag.justDragged = false;
  state.drag.target = targetEl.id;
  targetEl.setPointerCapture?.(e.pointerId);
}

function onDrag(e) {
  if (!state.drag.active) return;
  if (!state.drag.moved
    && (Math.abs(e.clientX - state.drag.startX) > 3
      || Math.abs(e.clientY - state.drag.startY) > 3)) {
    state.drag.moved = true;
  }

  const readerPanel = document.getElementById('vocab-break-reader-panel');
  const readerBar = document.getElementById('vocab-break-reader-bar');
  const isBar = state.drag.target === 'vocab-break-reader-bar';
  const targetEl = isBar ? readerBar : readerPanel;
  if (!targetEl) return;

  const fallback = isBar ? { width: 40, height: 40 } : getPanelSize();
  const size = getElementSize(targetEl, fallback);
  const x = e.clientX - state.drag.offsetX;
  const y = e.clientY - state.drag.offsetY;
  const clamped = clampPosition(x, y, size);

  if (isBar) {
    pluginConfig.barPos = clamped;
  } else {
    pluginConfig.panelPos = clamped;
  }
  applyFloatingPositions();
}

function endDrag() {
  if (!state.drag.active) return;
  state.drag.active = false;
  state.drag.justDragged = state.drag.moved;
  state.drag.target = '';
  if (state.drag.justDragged) {
    applyFloatingPositions();
  }
  saveSettings();
  if (state.drag.justDragged) {
    setTimeout(() => {
      state.drag.justDragged = false;
    }, 200);
  }
}

function bindDragEvents() {
  document.addEventListener('pointermove', onDrag);
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);
  window.addEventListener('resize', () => applyFloatingPositions());
  window.addEventListener('beforeunload', () => {
    flushReaderPosition({ silent: true });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushReaderPosition({ silent: true });
    }
  });
}

/* ========================= IndexedDB ========================= */

function openReaderDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const request = indexedDB.open(READER_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(READER_DB_STORE)) {
        db.createObjectStore(READER_DB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet(key) {
  const db = await openReaderDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(READER_DB_STORE, 'readonly');
    const store = tx.objectStore(READER_DB_STORE);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
  });
}

async function idbSet(key, value) {
  const db = await openReaderDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(READER_DB_STORE, 'readwrite');
    const store = tx.objectStore(READER_DB_STORE);
    const req = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
  });
}

async function idbDelete(key) {
  const db = await openReaderDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(READER_DB_STORE, 'readwrite');
    const store = tx.objectStore(READER_DB_STORE);
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
  });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function getEncodingLabel(id) {
  return TEXT_ENCODINGS.find(encoding => encoding.id === id)?.label || id;
}

/* ========================= 编码识别 ========================= */

function detectBomEncoding(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return 'utf-8';
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return 'utf-16le';
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return 'utf-16be';
  }
  return '';
}

function guessUtf16Encoding(bytes) {
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  let evenZeros = 0;
  let oddZeros = 0;
  let pairs = 0;
  for (let i = 0; i + 1 < sample.length; i += 2) {
    pairs += 1;
    if (sample[i] === 0) evenZeros += 1;
    if (sample[i + 1] === 0) oddZeros += 1;
  }
  if (!pairs) return '';
  if (evenZeros / pairs > 0.6) return 'utf-16be';
  if (oddZeros / pairs > 0.6) return 'utf-16le';
  return '';
}

function decodeBufferWithEncoding(buffer, encoding, options = {}) {
  try {
    const decoder = new TextDecoder(encoding, options);
    return { ok: true, text: decoder.decode(buffer) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

function scoreDecodedText(text) {
  const sample = String(text || '').slice(0, 20000);
  if (!sample) return -Infinity;
  const len = sample.length || 1;
  const replacementCount = (sample.match(/\uFFFD/g) || []).length;
  const nullCount = (sample.match(/\u0000/g) || []).length;
  const controlCount = (sample.match(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length;
  const penalty = replacementCount * 3 + nullCount * 2 + controlCount * 0.5;
  return 1 - penalty / len;
}

function decodeTextAuto(buffer) {
  const bytes = new Uint8Array(buffer);
  const bom = detectBomEncoding(bytes);
  if (bom) {
    const bomResult = decodeBufferWithEncoding(buffer, bom);
    if (bomResult.ok) {
      return { text: bomResult.text, encoding: bom, detected: true };
    }
  }

  const utf16Guess = guessUtf16Encoding(bytes);
  if (utf16Guess) {
    const guessResult = decodeBufferWithEncoding(buffer, utf16Guess);
    if (guessResult.ok) {
      return { text: guessResult.text, encoding: utf16Guess, detected: true };
    }
  }

  const utf8Strict = decodeBufferWithEncoding(buffer, 'utf-8', { fatal: true });
  if (utf8Strict.ok) {
    return { text: utf8Strict.text, encoding: 'utf-8', detected: true };
  }

  const candidates = ['utf-8', 'gbk', 'big5', 'utf-16le', 'utf-16be'];
  let best = null;
  for (const encoding of candidates) {
    const res = decodeBufferWithEncoding(buffer, encoding);
    if (!res.ok) continue;
    const score = scoreDecodedText(res.text);
    if (!best || score > best.score) {
      best = { encoding, text: res.text, score };
    }
  }
  if (best) {
    return { text: best.text, encoding: best.encoding, detected: true };
  }
  return { text: '', encoding: 'utf-8', detected: false };
}

async function readTextFromFile(file, encoding) {
  if (!file) return { text: '', encoding: 'utf-8', detected: false };
  if (typeof TextDecoder === 'undefined' || !file.arrayBuffer) {
    const text = await file.text();
    return { text, encoding: 'utf-8', detected: false };
  }
  const buffer = await file.arrayBuffer();
  if (encoding && encoding !== 'auto') {
    const res = decodeBufferWithEncoding(buffer, encoding);
    if (res.ok) {
      return { text: res.text, encoding, detected: false };
    }
  }
  return decodeTextAuto(buffer);
}

/* ========================= 外部脚本 / 文件解析 ========================= */

const SCRIPT_LOAD_CACHE = new Map();

function loadExternalScript(url, globalName) {
  if (globalName && globalThis[globalName]) {
    return Promise.resolve(globalThis[globalName]);
  }
  if (SCRIPT_LOAD_CACHE.has(url)) {
    return SCRIPT_LOAD_CACHE.get(url);
  }
  const promise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-vb-src="${url}"]`);
    const script = existing || document.createElement('script');
    if (!existing) {
      script.src = url;
      script.async = true;
      script.dataset.vbSrc = url;
      document.head.appendChild(script);
    }
    const cleanup = () => {
      script.removeEventListener('load', onLoad);
      script.removeEventListener('error', onError);
    };
    const onLoad = () => {
      cleanup();
      resolve(globalName ? globalThis[globalName] : true);
    };
    const onError = () => {
      cleanup();
      reject(new Error(`加载脚本失败：${url}`));
    };
    script.addEventListener('load', onLoad, { once: true });
    script.addEventListener('error', onError, { once: true });
  });
  SCRIPT_LOAD_CACHE.set(url, promise);
  return promise;
}

async function ensurePdfJs() {
  const lib = await loadExternalScript(PDFJS_CDN_URL, 'pdfjsLib');
  if (!lib) throw new Error('PDF 解析库加载失败');
  if (lib.GlobalWorkerOptions) {
    lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
  }
  return lib;
}

async function ensureJsZip() {
  const lib = await loadExternalScript(JSZIP_CDN_URL, 'JSZip');
  if (!lib) throw new Error('EPUB 解析库加载失败');
  return lib;
}

function normalizeWhitespace(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function getFileExtension(name) {
  const base = String(name || '').trim();
  const idx = base.lastIndexOf('.');
  if (idx <= 0) return '';
  return base.slice(idx + 1).toLowerCase();
}

function detectReaderFileKind(file) {
  if (!file) return 'txt';
  const ext = getFileExtension(file.name);
  const type = String(file.type || '').toLowerCase();
  if (ext === 'pdf' || type === 'application/pdf') return 'pdf';
  if (ext === 'epub' || type === 'application/epub+zip') return 'epub';
  return 'txt';
}

function normalizeEpubPath(path) {
  const parts = String(path || '').split('/');
  const stack = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.join('/');
}

function resolveEpubPath(base, rel) {
  const cleanRel = String(rel || '');
  if (!base) return normalizeEpubPath(cleanRel);
  return normalizeEpubPath(`${base}/${cleanRel}`);
}

function extractTextFromHtml(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html || '', 'text/html');
  const body = doc.body;
  const raw = body?.innerText || body?.textContent || doc.textContent || '';
  return normalizeWhitespace(raw);
}

async function extractPdfPages(file) {
  if (!file || !file.arrayBuffer) throw new Error('当前环境无法读取 PDF');
  const pdfjsLib = await ensurePdfJs();
  const buffer = await file.arrayBuffer();
  const task = pdfjsLib.getDocument({ data: buffer });
  const doc = await task.promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const chunks = [];
    for (const item of content.items || []) {
      const str = typeof item?.str === 'string' ? item.str : '';
      if (str) chunks.push(str);
      if (item?.hasEOL) chunks.push('\n');
    }
    const text = normalizeWhitespace(chunks.join(' '));
    pages.push(text || '（空白页）');
  }
  return pages;
}

async function extractEpubText(file) {
  if (!file || !file.arrayBuffer) throw new Error('当前环境无法读取 EPUB');
  const JSZip = await ensureJsZip();
  const buffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buffer);
  const container = zip.file('META-INF/container.xml');
  if (!container) throw new Error('EPUB 结构异常（缺少 container.xml）');
  const containerText = await container.async('text');
  const containerDoc = new DOMParser().parseFromString(containerText, 'application/xml');
  const rootfile = containerDoc.querySelector('rootfile');
  const opfPath = rootfile?.getAttribute('full-path');
  if (!opfPath) throw new Error('EPUB 结构异常（缺少 OPF）');
  const opfFile = zip.file(opfPath);
  if (!opfFile) throw new Error('EPUB 结构异常（缺少 OPF 不存在）');
  const opfText = await opfFile.async('text');
  const opfDoc = new DOMParser().parseFromString(opfText, 'application/xml');
  const manifest = new Map();
  opfDoc.querySelectorAll('manifest > item').forEach(item => {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    const mediaType = item.getAttribute('media-type');
    if (id && href) {
      manifest.set(id, { href, mediaType });
    }
  });
  const spineIds = Array.from(opfDoc.querySelectorAll('spine > itemref'))
    .map(node => node.getAttribute('idref'))
    .filter(Boolean);
  const baseDir = opfPath.includes('/') ? opfPath.split('/').slice(0, -1).join('/') : '';
  const texts = [];
  for (const id of spineIds) {
    const item = manifest.get(id);
    if (!item?.href) continue;
    const targetPath = resolveEpubPath(baseDir, item.href);
    const entry = zip.file(targetPath);
    if (!entry) continue;
    const html = await entry.async('text');
    const text = extractTextFromHtml(html);
    if (text) texts.push(text);
  }
  return normalizeWhitespace(texts.join('\n\n'));
}

/* ========================= 本地书架 ========================= */

function normalizeLibraryItems(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(item => {
      if (!item || typeof item !== 'object') return null;
      const id = String(item.id || '');
      if (!id) return null;
      const sourceRaw = String(item.source || item.format || 'txt');
      const source = sourceRaw === 'local' ? 'txt' : sourceRaw;
      return {
        id,
        title: String(item.title || '本地TXT'),
        updatedAt: Number(item.updatedAt) || 0,
        bytes: Number(item.bytes) || 0,
        source,
      };
    })
    .filter(Boolean);
}

async function loadReaderLibrary() {
  state.reader.library.loading = true;
  state.reader.library.error = '';
  updatePanel();
  try {
    const raw = await idbGet(READER_LIBRARY_INDEX_KEY);
    const items = normalizeLibraryItems(raw);
    items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    state.reader.library.items = items;
    if (!state.reader.library.selectedId && items.length) {
      state.reader.library.selectedId = items[0].id;
    }
  } catch (err) {
    state.reader.library.error = err instanceof Error ? err.message : String(err);
    state.reader.library.items = [];
  } finally {
    state.reader.library.loading = false;
    updatePanel();
  }
}

async function saveReaderLibraryIndex(items) {
  await idbSet(READER_LIBRARY_INDEX_KEY, items);
}

async function addReaderLibraryEntry({ title, content, sourceType }) {
  if (!content || !content.trim()) return null;
  const bytes = new Blob([content]).size;
  if (bytes > Number(pluginConfig.readerCacheMaxBytes)) {
    toastr?.warning?.('文件超过缓存上限，书架不会保存。', '阅读小窗');
    return null;
  }
  const safeTitle = title || '本地TXT';
  const source = sourceType || 'txt';
  const id = `local-${Date.now()}-${getStringHash(`${safeTitle}:${content.slice(0, 200)}`)}`;
  const entry = {
    id,
    title: safeTitle,
    updatedAt: Date.now(),
    bytes,
    source,
  };
  const removedByTitle = state.reader.library.items.filter(it => it.title === safeTitle);
  const next = state.reader.library.items.filter(it => it.title !== safeTitle);
  next.unshift(entry);
  const removed = next.splice(READER_LIBRARY_MAX_ITEMS);
  try {
    await idbSet(`${READER_LIBRARY_ITEM_PREFIX}${id}`, {
      ...entry,
      content,
    });
    for (const item of [...removed, ...removedByTitle]) {
      await idbDelete(`${READER_LIBRARY_ITEM_PREFIX}${item.id}`);
    }
    await saveReaderLibraryIndex(next);
    state.reader.library.items = next;
    state.reader.library.selectedId = id;
    updatePanel();
    return id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    toastr?.warning?.(`书架保存失败：${msg}`, '阅读小窗');
    return null;
  }
}

async function loadReaderLibraryEntry(id) {
  if (!id) return;
  if (state.reader.library.loading) return;

  /* 关键：切换书籍前，先把当前书的位置落盘 */
  flushReaderPosition({ silent: true });

  state.reader.library.loading = true;
  state.reader.library.error = '';
  updatePanel();

  try {
    const raw = await idbGet(`${READER_LIBRARY_ITEM_PREFIX}${id}`);
    if (!raw || typeof raw !== 'object' || !raw.content) {
      throw new Error('未找到内容');
    }
    state.reader.library.selectedId = id;
    setReaderText(raw.content, raw.title || '本地TXT', {
      bookKey: `book:${id}`,
      sourceType: raw.source === 'local' ? 'txt' : raw.source || 'txt',
    });
    setReaderPanelOpen(true);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    toastr?.error?.(`读取失败：${msg}`, '阅读小窗');
  } finally {
    state.reader.library.loading = false;
    updatePanel();
  }
}

async function removeReaderLibraryEntry(id) {
  if (!id) return;
  state.reader.library.loading = true;
  state.reader.library.error = '';
  updatePanel();
  try {
    await idbDelete(`${READER_LIBRARY_ITEM_PREFIX}${id}`);
    const next = state.reader.library.items.filter(it => it.id !== id);
    await saveReaderLibraryIndex(next);
    state.reader.library.items = next;
    if (state.reader.library.selectedId === id) {
      state.reader.library.selectedId = next[0]?.id || '';
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    toastr?.error?.(`删除失败：${msg}`, '阅读小窗');
  } finally {
    state.reader.library.loading = false;
    updatePanel();
  }
}

/* ========================= 阅读内容持久化 ========================= */

async function loadReaderFromStorage() {
  let text = '';
  let meta = null;
  let loadedFromIdb = false;

  try {
    const idbText = await idbGet(READER_CONTENT_IDB_KEY);
    const idbMeta = await idbGet(READER_META_IDB_KEY);
    if (typeof idbText === 'string') {
      text = idbText;
      meta = idbMeta || null;
      loadedFromIdb = true;
    }
  } catch {
    loadedFromIdb = false;
  }

  if (!text) {
    try {
      text = localStorage.getItem(READER_CONTENT_KEY) || '';
    } catch {
      text = '';
    }
    try {
      const raw = localStorage.getItem(READER_META_KEY);
      meta = raw ? JSON.parse(raw) : null;
    } catch {
      meta = null;
    }
  }

  if (!text) return;

  state.reader.text = text;
  state.reader.title = meta?.title || '本地TXT';
  state.reader.updatedAt = Number.isFinite(meta?.updatedAt) ? meta.updatedAt : 0;
  state.reader.cacheDisabled = false;
  state.reader.sourceType = meta?.sourceType || 'txt';

  const bookKey = meta?.bookKey
    || `local:${getStringHash(`${state.reader.title}:${text.slice(0, 200)}`)}`;
  /* setReaderBookKey 内部会从书签仓库读回 lastPage / scrollTop */
  setReaderBookKey(bookKey, meta?.bookTitle || state.reader.title);

  paginateReader({ keepPosition: false });

  const lastPage = Number(state.reader.lastPage) || 0;
  state.reader.pageIndex = lastPage > 0
    ? Math.min(Math.max(lastPage - 1, 0), Math.max(0, state.reader.pages.length - 1))
    : 0;

  /* 面板尚未打开，不立即应用滚动位置，等打开时由 setReaderPanelOpen 触发 */
  state.reader.pendingScrollTop = null;

  if (!loadedFromIdb) {
    void saveReaderToStorage();
  }
  updatePanel();
}

async function saveReaderToStorage() {
  if (state.reader.cacheDisabled) return;
  const meta = {
    title: state.reader.title || '本地TXT',
    updatedAt: state.reader.updatedAt || Date.now(),
    bookKey: state.reader.bookKey || '',
    bookTitle: state.reader.bookTitle || state.reader.title || '本地TXT',
    sourceType: state.reader.sourceType || 'txt',
  };
  try {
    await idbSet(READER_CONTENT_IDB_KEY, state.reader.text || '');
    await idbSet(READER_META_IDB_KEY, meta);
  } catch {
    try {
      localStorage.setItem(READER_CONTENT_KEY, state.reader.text || '');
      localStorage.setItem(READER_META_KEY, JSON.stringify(meta));
    } catch {
      toastr?.warning?.('阅读内容过大，无法保存到本地缓存。', '阅读小窗');
    }
  }
}

/* ========================= 进度 / 书签 ========================= */

function loadReaderBookmarksStore() {
  try {
    const raw = localStorage.getItem(READER_BOOKMARKS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveReaderBookmarksStore(store) {
  try {
    localStorage.setItem(READER_BOOKMARKS_KEY, JSON.stringify(store || {}));
  } catch {
    // ignore
  }
}

function getReaderBookKey() {
  return state.reader.bookKey || '';
}

function setReaderBookKey(bookKey, title) {
  state.reader.bookKey = bookKey || '';
  state.reader.bookTitle = title || state.reader.title || '';
  refreshReaderBookmarks();
}

function refreshReaderBookmarks() {
  const key = getReaderBookKey();
  if (!key) {
    state.reader.bookmarks = [];
    state.reader.lastPage = 0;
    state.reader.maxPage = 0;
    state.reader.savedScrollTop = 0;
    return;
  }
  const store = loadReaderBookmarksStore();
  const entry = store[key] || {
    title: state.reader.bookTitle || state.reader.title || '本地TXT',
    lastPage: 0,
    maxPage: 0,
    scrollTop: 0,
    bookmarks: [],
  };
  state.reader.bookmarks = Array.isArray(entry.bookmarks) ? entry.bookmarks : [];
  state.reader.lastPage = Number(entry.lastPage) || 0;
  state.reader.maxPage = Number(entry.maxPage) || 0;
  state.reader.savedScrollTop = Math.max(0, Number(entry.scrollTop) || 0);
}

function persistReaderBookmarks(updateFn) {
  const key = getReaderBookKey();
  if (!key) return;
  const store = loadReaderBookmarksStore();
  const entry = store[key] || {
    title: state.reader.bookTitle || state.reader.title || '本地TXT',
    lastPage: 0,
    maxPage: 0,
    scrollTop: 0,
    bookmarks: [],
  };
  if (typeof updateFn === 'function') {
    updateFn(entry);
  }
  entry.title = state.reader.bookTitle || state.reader.title || entry.title;
  store[key] = entry;
  saveReaderBookmarksStore(store);
  refreshReaderBookmarks();
}

/**
 * 把内存里的进度写进当前书的存储条目。
 * 只认 state.reader.savedScrollTop —— 这是滚动时即时记录的真实位置。
 */
function syncReaderProgress() {
  if (!state.reader.bookKey) return;

  if (readerProgressSaveTimer) {
    clearTimeout(readerProgressSaveTimer);
    readerProgressSaveTimer = null;
  }

  const total = state.reader.pages.length;
  const currentPage = total ? state.reader.pageIndex + 1 : 0;
  const scrollTop = Math.max(0, Number(state.reader.savedScrollTop) || 0);

  persistReaderBookmarks(entry => {
    entry.lastPage = currentPage;
    entry.maxPage = Math.max(Number(entry.maxPage) || 0, currentPage);
    entry.scrollTop = scrollTop;
  });

  /* refreshReaderBookmarks 会读回存储值，这里再压一次，确保内存与写入一致 */
  state.reader.savedScrollTop = scrollTop;
}

function scheduleReaderProgressSave() {
  if (readerProgressSaveTimer) clearTimeout(readerProgressSaveTimer);
  readerProgressSaveTimer = setTimeout(() => {
    readerProgressSaveTimer = null;
    syncReaderProgress();
    void saveReaderToStorage();
  }, PROGRESS_SAVE_DELAY);
}

/**
 * 立即落盘当前位置。
 * 注意顺序：必须在面板仍然可见时读取 scrollTop —— 一旦 display:none，scrollTop 会变 0。
 */
function flushReaderPosition({ silent = false } = {}) {
  if (readerProgressSaveTimer) {
    clearTimeout(readerProgressSaveTimer);
    readerProgressSaveTimer = null;
  }

  const panel = document.getElementById('vocab-break-reader-panel');
  const pageEl = panel?.querySelector('.vb-reader-page');
  const visible = !!panel && panel.classList.contains('is-open');

  if (visible && pageEl instanceof HTMLElement) {
    state.reader.savedScrollTop = Math.max(0, pageEl.scrollTop || 0);
  }

  if (!state.reader.bookKey) return;

  syncReaderProgress();
  if (!silent) {
    void saveReaderToStorage();
  }
}

function addReaderBookmark() {
  if (!state.reader.pages.length) return;
  const page = state.reader.pageIndex + 1;
  const label = state.reader.chapterTitles[state.reader.pageIndex] || `第${page}章`;
  persistReaderBookmarks(entry => {
    entry.bookmarks = Array.isArray(entry.bookmarks) ? entry.bookmarks : [];
    entry.bookmarks.push({ page, label, ts: Date.now() });
  });
  updatePanel();
}

function removeReaderBookmark(index) {
  persistReaderBookmarks(entry => {
    entry.bookmarks = Array.isArray(entry.bookmarks) ? entry.bookmarks : [];
    entry.bookmarks.splice(index, 1);
  });
  updatePanel();
}

function migrateReaderBookmarks(fromKey, toKey) {
  if (!fromKey || !toKey || fromKey === toKey) return;
  const store = loadReaderBookmarksStore();
  if (!store[fromKey]) return;
  if (!store[toKey]) {
    store[toKey] = store[fromKey];
  }
  delete store[fromKey];
  saveReaderBookmarksStore(store);
}

/* ========================= 主题 ========================= */

function applyTheme() {
  const panel = document.getElementById('vocab-break-reader-panel');
  const bar = document.getElementById('vocab-break-reader-bar');
  const els = [panel, bar].filter(Boolean);
  if (!els.length) return;

  for (const el of els) {
    el.classList.forEach(cls => {
      if (cls.startsWith(THEME_PREFIX)) el.classList.remove(cls);
    });
    el.classList.add(`${THEME_PREFIX}${pluginConfig.theme}`);
  }
  applyCustomCss();
}

function applyCustomCss() {
  const existing = document.getElementById(CUSTOM_STYLE_ID);
  if (pluginConfig.theme !== 'custom') {
    if (existing) existing.remove();
    return;
  }
  const css = pluginConfig.customCss || '';
  const style = existing || Object.assign(document.createElement('style'), { id: CUSTOM_STYLE_ID });
  style.textContent = css;
  if (!existing) document.head.appendChild(style);
}

function getReaderSourceLabel(source) {
  const raw = String(source || '').toLowerCase();
  if (!raw || raw === 'local') return '';
  if (raw === 'txt') return 'TXT';
  if (raw === 'pdf') return 'PDF';
  if (raw === 'epub') return 'EPUB';
  if (raw === 'remote') return '远程';
  return raw.toUpperCase();
}

/* ========================= 章节识别与分页 ========================= */

function detectReaderChapters(text) {
  const raw = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!raw) return { chapters: [], titles: [] };

  const lines = raw.split('\n');
  const heading = /^\s*(?:(?:第\s*[〇零一二三四五六七八九十百千万两\d]+\s*[章节回卷部篇集幕节].*)|(?:序章|楔子|前言|引子|尾声|后记|番外(?:篇)?|终章|正文)|(?:chapter|prologue|epilogue)\s*[\d〇零一二三四五六七八九十百千万两-]*.*)$/i;

  const starts = [];
  let offset = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && heading.test(trimmed)) starts.push({ offset, title: trimmed });
    offset += line.length + 1;
  }

  if (starts.length >= 2) {
    if (starts[0].offset > 0 && raw.slice(0, starts[0].offset).trim()) {
      starts.unshift({ offset: 0, title: '前言' });
    }
    const chapters = [];
    const titles = [];
    for (let i = 0; i < starts.length; i += 1) {
      const chunk = raw.slice(starts[i].offset, starts[i + 1]?.offset ?? raw.length).trim();
      if (chunk) {
        chapters.push(chunk);
        titles.push(starts[i].title || String(chapters.length));
      }
    }
    if (chapters.length) return { chapters, titles };
  }

  /* 识别失败：按段落长度切块，标题用 1、2、3 数字 */
  const paragraphs = raw.split(/\n[ \t]*\n+/).map(v => v.trim()).filter(Boolean);
  const chapters = [];
  let chunk = '';
  for (const paragraph of paragraphs) {
    if (chunk && chunk.length + paragraph.length + 2 > 5000) {
      chapters.push(chunk.trim());
      chunk = '';
    }
    if (paragraph.length > 6500 && !chunk) {
      for (let i = 0; i < paragraph.length; i += 5000) {
        chapters.push(paragraph.slice(i, i + 5000).trim());
      }
      continue;
    }
    chunk += (chunk ? '\n\n' : '') + paragraph;
  }
  if (chunk.trim()) chapters.push(chunk.trim());
  return { chapters, titles: chapters.map((_, i) => String(i + 1)) };
}

function paginateReader({ keepPosition } = {}) {
  const text = state.reader.text || '';
  if (!text) {
    state.reader.pages = [];
    state.reader.chapterTitles = [];
    state.reader.pageIndex = 0;
    return;
  }
  const oldIndex = state.reader.pageIndex;
  const result = detectReaderChapters(text);
  state.reader.pages = result.chapters;
  state.reader.chapterTitles = result.titles;
  if (!state.reader.pages.length) {
    state.reader.pageIndex = 0;
    return;
  }
  state.reader.pageIndex = keepPosition
    ? Math.min(Math.max(oldIndex, 0), state.reader.pages.length - 1)
    : 0;
}

/* ========================= 正文渲染 / 滚动 ========================= */

function getPageRenderKey() {
  const page = state.reader.pages[state.reader.pageIndex] || '';
  return [
    state.reader.bookKey,
    state.reader.pageIndex,
    state.reader.pages.length,
    page.length,
    getStringHash(page.slice(0, 240)),
    Number(pluginConfig.readerFontSize) || 0,
    Number(pluginConfig.readerLineHeight) || 0,
    Number(pluginConfig.readerParagraphSpacing) || 0,
  ].join('|');
}

/**
 * 应用待恢复的滚动位置。只在面板可见时执行，否则保留 pending 等下次打开。
 * 用双 rAF 保证 DOM 已经完成布局、scrollHeight 已可信。
 */
function applyPendingScrollToPage() {
  const pending = state.reader.pendingScrollTop;
  if (pending === null || pending === undefined) return;

  const panel = document.getElementById('vocab-break-reader-panel');
  if (!panel || !panel.classList.contains('is-open')) return;

  const pageEl = panel.querySelector('.vb-reader-page');
  if (!(pageEl instanceof HTMLElement)) return;

  const target = Math.max(0, Number(pending) || 0);
  state.reader.pendingScrollTop = null;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const max = Math.max(0, pageEl.scrollHeight - pageEl.clientHeight);
      pageEl.scrollTop = Math.min(target, max);
      state.reader.savedScrollTop = Math.max(0, pageEl.scrollTop || 0);
      updateReaderPercent();
    });
  });
}

function updateReaderPercent() {
  const panel = document.getElementById('vocab-break-reader-panel');
  if (!panel) return;
  const percentEl = panel.querySelector('.vb-reader-percent');
  if (!(percentEl instanceof HTMLElement)) return;

  if (!state.reader.pages.length) {
    percentEl.textContent = '全文进度 0%';
    return;
  }
  if (!panel.classList.contains('is-open')) return;

  const pageEl = panel.querySelector('.vb-reader-page');
  const totalLength = state.reader.pages.reduce((sum, part) => sum + part.length, 0) || 1;
  const before = state.reader.pages
    .slice(0, state.reader.pageIndex)
    .reduce((sum, part) => sum + part.length, 0);
  const currentText = state.reader.pages[state.reader.pageIndex] || '';

  let within = currentText.length;
  if (pageEl instanceof HTMLElement) {
    const maxScroll = pageEl.scrollHeight - pageEl.clientHeight;
    if (maxScroll > 0) {
      const ratio = Math.min(1, Math.max(0, (pageEl.scrollTop || 0) / maxScroll));
      within = Math.round(ratio * currentText.length);
    }
  }

  const percent = Math.min(100, Math.round(((before + within) / totalLength) * 100));
  percentEl.textContent = `全文进度 ${percent}%`;
}

/* ========================= 阅读内容切换 ========================= */

function setReaderText(text, title, options = {}) {
  /* 先把上一本书的位置落盘，再换内容 */
  flushReaderPosition({ silent: true });

  const nextText = String(text || '');
  const byteSize = new Blob([nextText]).size;
  state.reader.cacheDisabled = byteSize > Number(pluginConfig.readerCacheMaxBytes);
  state.reader.text = nextText;
  state.reader.title = title || '本地TXT';
  state.reader.sourceType = options.sourceType || 'txt';
  state.reader.updatedAt = Date.now();
  state.reader.pageIndex = 0;
  state.reader.savedScrollTop = 0;
  state.reader.pendingScrollTop = null;

  const bookKey = options.bookKey
    || `local:${getStringHash(`${state.reader.title}:${nextText.slice(0, 200)}`)}`;
  /* 这里会把该书上次保存的 lastPage / scrollTop 读回内存 */
  setReaderBookKey(bookKey, title);

  paginateReader({ keepPosition: false });

  const lastPage = Number(state.reader.lastPage) || 0;
  state.reader.pageIndex = lastPage > 0
    ? Math.min(Math.max(lastPage - 1, 0), Math.max(0, state.reader.pages.length - 1))
    : 0;

  /* 恢复该书上次的章节内滚动位置 */
  state.reader.pendingScrollTop = Math.max(0, Number(state.reader.savedScrollTop) || 0);

  syncReaderProgress();

  if (state.reader.cacheDisabled) {
    toastr?.warning?.('文件较大，已加载但不会缓存到本地。', '阅读小窗');
  } else {
    void saveReaderToStorage();
  }

  updatePanel();
}

function clearReaderText() {
  flushReaderPosition({ silent: true });

  state.reader.text = '';
  state.reader.pages = [];
  state.reader.chapterTitles = [];
  state.reader.pageIndex = 0;
  state.reader.title = '';
  state.reader.updatedAt = 0;
  state.reader.cacheDisabled = false;
  state.reader.bookKey = '';
  state.reader.bookTitle = '';
  state.reader.lastPage = 0;
  state.reader.maxPage = 0;
  state.reader.bookmarks = [];
  state.reader.savedScrollTop = 0;
  state.reader.pendingScrollTop = null;
  pageRenderKey = '';

  try {
    localStorage.removeItem(READER_CONTENT_KEY);
    localStorage.removeItem(READER_META_KEY);
  } catch {
    // ignore
  }
  void idbDelete(READER_CONTENT_IDB_KEY).catch(() => {});
  void idbDelete(READER_META_IDB_KEY).catch(() => {});
  updatePanel();
}

/* ========================= 章节跳转 ========================= */

function goToReaderChapter(index) {
  if (!state.reader.pages.length) return;
  const total = state.reader.pages.length;
  const target = Math.min(Math.max(0, Math.floor(Number(index) || 0)), total - 1);

  state.reader.pageIndex = target;
  /* 切章一律回到顶端 */
  state.reader.savedScrollTop = 0;
  state.reader.pendingScrollTop = 0;

  syncReaderProgress();
  void saveReaderToStorage();
  updatePanel();
}

function readerPrev() {
  if (state.reader.pageIndex <= 0) return;
  goToReaderChapter(state.reader.pageIndex - 1);
}

function readerNext() {
  if (state.reader.pageIndex >= state.reader.pages.length - 1) return;
  goToReaderChapter(state.reader.pageIndex + 1);
}

function jumpToReaderBookmark(page) {
  if (!state.reader.pages.length) return;
  goToReaderChapter(Number(page) - 1);
}

/* ========================= 远程章节 ========================= */

async function loadRemoteIndex({ force } = {}) {
  const src = getRemoteSource();
  if (!src?.indexUrl) return;
  if (!force && state.remote.sourceId === src.id && state.remote.chapters.length) {
    return;
  }

  state.remote.loadingIndex = true;
  state.remote.error = '';
  updatePanel();

  try {
    const res = await fetch(src.indexUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    let chapters = [];
    if (src.type === 'summary-md') {
      chapters = parseSummaryMarkdown(text, src.chapterPrefix);
    }

    if (!chapters.length) throw new Error('未解析到章节目录');

    state.remote.sourceId = src.id;
    state.remote.chapters = chapters;
    state.remote.updatedAt = Date.now();
    pluginConfig.readerRemoteSourceId = src.id;

    if (!pluginConfig.readerRemoteChapterUrl
      || !chapters.some(c => c.url === pluginConfig.readerRemoteChapterUrl)) {
      pluginConfig.readerRemoteChapterUrl = chapters[0]?.url || '';
    }
    saveSettings();

    if (state.readerPanelOpen && !state.reader.text && pluginConfig.readerRemoteChapterUrl) {
      loadRemoteChapter(pluginConfig.readerRemoteChapterUrl);
    }
  } catch (err) {
    state.remote.error = err instanceof Error ? err.message : String(err);
  } finally {
    state.remote.loadingIndex = false;
    updatePanel();
  }
}

async function loadRemoteChapter(url) {
  if (!url) return;
  flushReaderPosition({ silent: true });
  state.remote.loadingChapter = true;
  state.remote.error = '';
  updatePanel();
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const isNotebook = url.toLowerCase().endsWith('.ipynb');
    const content = isNotebook ? extractNotebookText(text) : text;
    const title = state.remote.chapters.find(c => c.url === url)?.title || '远程章节';
    setReaderText(content, title, { bookKey: `remote:${url}`, sourceType: 'remote' });
    pluginConfig.readerRemoteChapterUrl = url;
    saveSettings();
  } catch (err) {
    state.remote.error = err instanceof Error ? err.message : String(err);
  } finally {
    state.remote.loadingChapter = false;
    updatePanel();
  }
}

/* ========================= 面板开关 ========================= */

function setReaderPanelOpen(open) {
  if (!pluginConfig.enableReader && open) return;
  const panel = document.getElementById('vocab-break-reader-panel');

  if (open) {
    state.readerPanelOpen = true;
    if (panel) panel.classList.add('is-open');
    /* 打开前先把内存里记录的滚动位置交给渲染层 */
    state.reader.pendingScrollTop = Math.max(0, Number(state.reader.savedScrollTop) || 0);
    updatePanel();
    ensurePanelInView(panel);
    return;
  }

  /* 关键：先落盘，再隐藏。顺序反了 scrollTop 会读成 0 */
  flushReaderPosition({ silent: true });
  state.readerPanelOpen = false;
  if (panel) panel.classList.remove('is-open');
  updatePanel();
}

/* ========================= 面板刷新 ========================= */

function updateReaderPanel() {
  const panel = document.getElementById('vocab-break-reader-panel');
  if (!panel) return;
  if (!pluginConfig.enableReader) {
    panel.classList.remove('is-open');
  }

  panel.classList.toggle('is-compact', isCompactViewport());

  const readerTitleEl = panel.querySelector('.vb-reader-title');
  const readerPageEl = panel.querySelector('.vb-reader-page');
  const readerMetaEl = panel.querySelector('.vb-reader-meta');
  const readerEncodingSelect = panel.querySelector('.vb-reader-encoding-select');
  const remoteSourceSelect = panel.querySelector('.vb-remote-source');
  const remoteChapterSelect = panel.querySelector('.vb-remote-chapter');
  const remoteStatusEl = panel.querySelector('.vb-reader-remote-status');
  const libraryStatusEl = panel.querySelector('.vb-reader-library-status');
  const bookmarkCount = panel.querySelector('.vb-reader-bookmarks-count');
  const prevBtn = panel.querySelector('.vb-reader-prev');
  const nextBtn = panel.querySelector('.vb-reader-next');

  if (readerTitleEl) {
    if (state.reader.title) {
      const sourceLabel = getReaderSourceLabel(state.reader.sourceType);
      readerTitleEl.textContent = sourceLabel
        ? `${state.reader.title} · ${sourceLabel}`
        : state.reader.title;
    } else {
      readerTitleEl.textContent = '未导入阅读内容 / 未加载远程章节';
    }
  }

  /* ---- 正文：只有渲染指纹变化时才重建，保住滚动位置 ---- */
  if (readerPageEl instanceof HTMLElement) {
    const renderKey = getPageRenderKey();
    if (renderKey !== pageRenderKey) {
      pageRenderKey = renderKey;
      readerPageEl.replaceChildren();

      if (!state.reader.pages.length) {
        readerPageEl.textContent = '请点击右上角 📄 导入小说文件';
      } else {
        const gap = Math.max(0, Number(pluginConfig.readerParagraphSpacing) || 0);
        const pageText = state.reader.pages[state.reader.pageIndex] || '';
        pageText.split(/\n[ \t]*\n+/).forEach(paragraph => {
          const paragraphEl = document.createElement('div');
          paragraphEl.className = 'vb-reader-paragraph';
          paragraphEl.textContent = paragraph;
          paragraphEl.style.marginBottom = `${gap}px`;
          readerPageEl.appendChild(paragraphEl);
        });
      }
    }

    readerPageEl.style.fontSize = `${Number(pluginConfig.readerFontSize || 14)}px`;
    readerPageEl.style.lineHeight = String(Number(pluginConfig.readerLineHeight || 1.6));
  }

  if (readerMetaEl) {
    if (!state.reader.pages.length) {
      readerMetaEl.textContent = '';
    } else {
      readerMetaEl.textContent = `第 ${state.reader.pageIndex + 1} / ${state.reader.pages.length} 章`;
    }
  }

  if (prevBtn instanceof HTMLButtonElement) {
    prevBtn.disabled = !state.reader.pages.length || state.reader.pageIndex <= 0;
  }
  if (nextBtn instanceof HTMLButtonElement) {
    nextBtn.disabled = !state.reader.pages.length
      || state.reader.pageIndex >= state.reader.pages.length - 1;
  }

  /* ---- 弹层显隐 ---- */
  const remotePopover = panel.querySelector('.vb-reader-remote');
  if (remotePopover) remotePopover.style.display = readerRemotePopoverOpen ? 'flex' : 'none';

  const tocPopover = panel.querySelector('.vb-reader-toc');
  if (tocPopover) tocPopover.style.display = readerTocPopoverOpen ? 'flex' : 'none';

  const libraryPopover = panel.querySelector('.vb-reader-library');
  if (libraryPopover) libraryPopover.style.display = readerLibraryPopoverOpen ? 'flex' : 'none';

  const bookmarkPopover = panel.querySelector('.vb-reader-bookmarks-popover');
  if (bookmarkPopover) bookmarkPopover.style.display = readerBookmarkPopoverOpen ? 'flex' : 'none';

  const remoteBtn = panel.querySelector('.vb-reader-remote-btn');
  if (remoteBtn) remoteBtn.classList.toggle('is-on', readerRemotePopoverOpen);

  const libraryBtn = panel.querySelector('.vb-reader-library-btn');
  if (libraryBtn) libraryBtn.classList.toggle('is-on', readerLibraryPopoverOpen);

  const tocBtn = panel.querySelector('.vb-reader-toc-btn');
  if (tocBtn) tocBtn.classList.toggle('is-on', readerTocPopoverOpen);

  const bookmarkIcon = panel.querySelector('.vb-reader-bookmark-icon');
  if (bookmarkIcon) {
    bookmarkIcon.classList.toggle('is-on', readerBookmarkPopoverOpen);
    bookmarkIcon.textContent = state.reader.bookmarks.length > 0 ? '🚩' : '⚑';
  }

  /* ---- 远程教材 ---- */
  if (remoteSourceSelect) {
    remoteSourceSelect.innerHTML = REMOTE_SOURCES
      .map(s => `<option value="${s.id}">${s.label}</option>`)
      .join('');
    remoteSourceSelect.value = pluginConfig.readerRemoteSourceId;
  }

  if (remoteChapterSelect) {
    const chapters = state.remote.chapters || [];
    if (!chapters.length) {
      remoteChapterSelect.innerHTML = '<option value="">（请先加载目录）</option>';
    } else {
      remoteChapterSelect.innerHTML = chapters
        .map((c, i) => `<option value="${c.url}">${i + 1}. ${c.title}</option>`)
        .join('');
      const savedUrl = pluginConfig.readerRemoteChapterUrl;
      if (savedUrl && chapters.some(c => c.url === savedUrl)) {
        remoteChapterSelect.value = savedUrl;
      } else {
        remoteChapterSelect.value = chapters[0].url;
      }
    }
  }

  if (remoteStatusEl) {
    if (state.remote.loadingIndex) {
      remoteStatusEl.textContent = '目录加载中...';
    } else if (state.remote.loadingChapter) {
      remoteStatusEl.textContent = '章节加载中...';
    } else if (state.remote.error) {
      remoteStatusEl.textContent = `错误：${state.remote.error}`;
    } else if (state.remote.chapters.length) {
      remoteStatusEl.textContent = `目录 ${state.remote.chapters.length} 章`;
    } else {
      remoteStatusEl.textContent = '未加载目录';
    }
  }

  /* ---- 章节目录 ---- */
  const tocList = panel.querySelector('.vb-reader-toc-list');
  if (tocList instanceof HTMLElement) {
    tocList.replaceChildren();
    if (!state.reader.chapterTitles.length) {
      const empty = document.createElement('div');
      empty.className = 'vb-reader-toc-empty';
      empty.textContent = '暂无章节';
      tocList.appendChild(empty);
    } else {
      state.reader.chapterTitles.forEach((title, index) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'vb-reader-toc-item';
        item.classList.toggle('is-current', index === state.reader.pageIndex);
        item.textContent = /^\d+$/.test(String(title))
          ? `第 ${title} 章`
          : `${index + 1}. ${title}`;
        item.addEventListener('click', () => {
          goToReaderChapter(index);
          readerTocPopoverOpen = false;
          readerRemotePopoverOpen = false;
          readerLibraryPopoverOpen = false;
          readerBookmarkPopoverOpen = false;
          updatePanel();
        });
        tocList.appendChild(item);
      });
    }
  }

  /* ---- 本地书架 ---- */
  const libraryList = panel.querySelector('.vb-reader-library-list');
  if (libraryList instanceof HTMLElement) {
    libraryList.replaceChildren();
    const items = state.reader.library.items || [];
    if (state.reader.library.loading) {
      const empty = document.createElement('div');
      empty.className = 'vb-reader-library-empty';
      empty.textContent = '书架处理中...';
      libraryList.appendChild(empty);
    } else if (state.reader.library.error) {
      const empty = document.createElement('div');
      empty.className = 'vb-reader-library-empty';
      empty.textContent = `书架错误：${state.reader.library.error}`;
      libraryList.appendChild(empty);
    } else if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'vb-reader-library-empty';
      empty.textContent = '书架为空';
      libraryList.appendChild(empty);
    } else {
      items.forEach(it => {
        const row = document.createElement('div');
        row.className = 'vb-reader-library-item';
        if (it.id === state.reader.library.selectedId
          && state.reader.bookKey === `book:${it.id}`) {
          row.classList.add('is-current');
        }

        const titleDiv = document.createElement('div');
        titleDiv.className = 'vb-reader-library-item-title';
        const typeLabel = getReaderSourceLabel(it.source);
        const size = it.bytes ? ` · ${formatBytes(it.bytes)}` : '';
        titleDiv.textContent = `${it.title}${typeLabel ? ` · ${typeLabel}` : ''}${size}`;

        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'vb-library-open';
        openBtn.dataset.libraryOpen = it.id;
        openBtn.textContent = '打开';

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'vb-library-delete';
        delBtn.dataset.libraryDelete = it.id;
        delBtn.textContent = '删除';

        row.appendChild(titleDiv);
        row.appendChild(openBtn);
        row.appendChild(delBtn);
        libraryList.appendChild(row);
      });
    }
  }

  if (libraryStatusEl) {
    if (state.reader.library.loading) {
      libraryStatusEl.textContent = '书架处理中...';
    } else if (state.reader.library.error) {
      libraryStatusEl.textContent = `书架错误：${state.reader.library.error}`;
    } else if (state.reader.library.items.length) {
      libraryStatusEl.textContent = `已保存 ${state.reader.library.items.length} 本`;
    } else {
      libraryStatusEl.textContent = '书架为空';
    }
  }

  /* ---- 书签 ---- */
  if (bookmarkCount instanceof HTMLElement) {
    bookmarkCount.textContent = String(state.reader.bookmarks.length || 0);
  }

  const bookmarkAdd = panel.querySelector('.vb-reader-bookmark-add');
  if (bookmarkAdd instanceof HTMLButtonElement) {
    bookmarkAdd.disabled = !state.reader.pages.length;
  }

  const bookmarkList = panel.querySelector('.vb-reader-bookmarks-list');
  if (bookmarkList instanceof HTMLElement) {
    bookmarkList.innerHTML = '';
    if (!state.reader.bookmarks.length) {
      const empty = document.createElement('div');
      empty.className = 'vb-reader-bookmark-empty';
      empty.textContent = '暂无书签';
      bookmarkList.appendChild(empty);
    } else {
      state.reader.bookmarks.forEach((bm, idx) => {
        const row = document.createElement('div');
        row.className = 'vb-reader-bookmark-row';

        const label = document.createElement('button');
        label.type = 'button';
        label.className = 'vb-reader-bookmark-jump';
        label.dataset.bookmarkJump = '1';
        label.dataset.page = String(bm.page || 0);
        label.textContent = bm.label || `第${bm.page}章`;

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'vb-reader-bookmark-delete';
        del.dataset.bookmarkDelete = '1';
        del.dataset.index = String(idx);
        del.textContent = '删除';

        row.appendChild(label);
        row.appendChild(del);
        bookmarkList.appendChild(row);
      });
    }
  }

  if (readerEncodingSelect instanceof HTMLSelectElement) {
    readerEncodingSelect.innerHTML = TEXT_ENCODINGS
      .map(encoding => `<option value="${encoding.id}">${encoding.label}</option>`)
      .join('');
    readerEncodingSelect.value = pluginConfig.readerEncoding;
  }

  updateReaderPercent();
  applyPendingScrollToPage();
}

function updatePanel() {
  updateReaderPanel();
  applyPanelSizing();

  const readerBar = document.getElementById('vocab-break-reader-bar');
  if (readerBar) {
    const shouldShow = pluginConfig.enableReader && !state.readerPanelOpen;
    readerBar.classList.toggle('is-open', shouldShow);
    const title = readerBar.querySelector('.vb-bar-title');
    if (title) title.textContent = '阅读小窗';
  }

  applyFloatingPositions();
  const readerPanel = document.getElementById('vocab-break-reader-panel');
  if (readerPanel) ensurePanelInView(readerPanel);
  applyTheme();
}

/* ========================= 导入文件 ========================= */

async function importReaderFile(file) {
  if (!file) return;
  flushReaderPosition({ silent: true });

  const kind = detectReaderFileKind(file);

  if (kind === 'pdf') {
    toastr?.info?.('正在解析 PDF，请稍候...', '阅读小窗');
    const pages = await extractPdfPages(file);
    if (!pages.length) {
      toastr?.warning?.('PDF 没有可读取的文本。', '阅读小窗');
      return;
    }
    const content = pages.join('\n\n');
    const sample = pages.find(p => p && p !== '（空白页）') || pages[0] || '';
    const tempKey = `local:${getStringHash(`${file.name}:${sample.slice(0, 200)}`)}`;
    setReaderText(content, file.name, { bookKey: tempKey, sourceType: 'pdf' });
    await finalizeImportedBook(file.name, content, 'pdf', tempKey);
    toastr?.success?.('已导入 PDF 阅读内容。', '阅读小窗');
    return;
  }

  if (kind === 'epub') {
    toastr?.info?.('正在解析 EPUB，请稍候...', '阅读小窗');
    const text = await extractEpubText(file);
    if (!text || !text.trim()) {
      toastr?.warning?.('EPUB 没有可读取的文本。', '阅读小窗');
      return;
    }
    const tempKey = `local:${getStringHash(`${file.name}:${text.slice(0, 200)}`)}`;
    setReaderText(text, file.name, { bookKey: tempKey, sourceType: 'epub' });
    await finalizeImportedBook(file.name, text, 'epub', tempKey);
    toastr?.success?.('已导入 EPUB 阅读内容。', '阅读小窗');
    return;
  }

  const result = await readTextFromFile(file, pluginConfig.readerEncoding);
  const text = result.text;
  if (!text || !text.trim()) {
    toastr?.warning?.('TXT 为空或无法读取。', '阅读小窗');
    return;
  }
  const tempKey = `local:${getStringHash(`${file.name}:${text.slice(0, 200)}`)}`;
  setReaderText(text, file.name, { bookKey: tempKey, sourceType: 'txt' });
  await finalizeImportedBook(file.name, text, 'txt', tempKey);

  if (pluginConfig.readerEncoding === 'auto' && result.detected) {
    const encodingId = result.encoding;
    if (encodingId && encodingId !== 'utf-8') {
      const label = getEncodingLabel(encodingId);
      toastr?.info?.(`自动识别编码：${label}`, '阅读小窗');
    }
  } else if (pluginConfig.readerEncoding !== 'auto' && result.detected) {
    const label = getEncodingLabel(result.encoding);
    toastr?.warning?.(`所选编码不可用，已回退为 ${label || '自动识别'}`, '阅读小窗');
  }
  toastr?.success?.('已导入 TXT 阅读内容。', '阅读小窗');
}

async function finalizeImportedBook(title, content, sourceType, tempKey) {
  const entryId = await addReaderLibraryEntry({ title, content, sourceType });
  if (entryId) {
    const newKey = `book:${entryId}`;
    migrateReaderBookmarks(tempKey, newKey);
    setReaderBookKey(newKey, title);
    state.reader.pageIndex = 0;
    state.reader.savedScrollTop = 0;
    state.reader.pendingScrollTop = 0;
    syncReaderProgress();
    void saveReaderToStorage();
  }
  setReaderPanelOpen(true);
  updatePanel();
}

function ensureReaderFileInput() {
  if (document.getElementById('vocab-break-reader-file')) return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.txt,.pdf,.epub,text/plain,application/pdf,application/epub+zip';
  input.id = 'vocab-break-reader-file';
  input.style.display = 'none';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      await importReaderFile(file);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toastr?.error?.(msg, '阅读小窗');
    } finally {
      input.value = '';
    }
  });
  document.body.appendChild(input);
}

function openReaderFilePicker() {
  ensureReaderFileInput();
  const input = document.getElementById('vocab-break-reader-file');
  if (input instanceof HTMLInputElement) input.click();
}

/* ========================= DOM 构建 ========================= */

function ensureReaderBar() {
  if (document.getElementById('vocab-break-reader-bar')) return;
  const bar = document.createElement('div');
  bar.id = 'vocab-break-reader-bar';
  bar.innerHTML = `
    <div class="vb-bar-title">阅读小窗</div>
    <div class="vb-bar-caret">▾</div>
  `;
  bar.addEventListener('pointerdown', e => {
    beginDrag(e, bar);
  });
  bar.addEventListener('click', () => {
    if (state.drag.justDragged) {
      state.drag.justDragged = false;
      return;
    }
    if (!pluginConfig.enableReader) return;
    setReaderPanelOpen(true);
  });
  document.body.appendChild(bar);
  applyTheme();
}

function ensureReaderPanel() {
  if (document.getElementById('vocab-break-reader-panel')) return;
  const panel = document.createElement('div');
  panel.id = 'vocab-break-reader-panel';
  panel.classList.add('is-reader');
  panel.innerHTML = `
    <div class="vb-header">
      <div class="vb-title">阅读小窗</div>
      <div class="vb-header-actions">
        <button class="vb-reader-remote-btn" type="button" title="远程教材">☁</button>
        <button class="vb-reader-library-btn" type="button" title="本地书架">🗂</button>
        <button class="vb-reader-toc-btn" type="button" title="章节目录">☷</button>
        <button class="vb-close" type="button" title="关闭">✕</button>
      </div>
    </div>
    <div class="vb-body vb-body-reader">
      <div class="vb-reader-remote vb-popover" style="display:none">
        <div class="vb-reader-remote-head">
          <div class="vb-reader-remote-title">远程教材</div>
          <button class="vb-reader-remote-close" type="button">✕</button>
        </div>
        <div class="vb-reader-remote-body">
          <div class="vb-reader-remote-row">
            <select class="vb-remote-source"></select>
            <button class="vb-remote-refresh" type="button">加载目录</button>
          </div>
          <div class="vb-reader-remote-row">
            <select class="vb-remote-chapter"></select>
            <button class="vb-remote-load" type="button">加载章节</button>
          </div>
          <div class="vb-reader-remote-status"></div>
        </div>
        <div class="vb-reader-encoding">
          <span class="vb-reader-encoding-label">编码</span>
          <select class="vb-reader-encoding-select"></select>
        </div>
      </div>
      <div class="vb-reader-toc vb-popover" style="display:none">
        <div class="vb-reader-toc-head">
          <span>章节目录</span>
          <button class="vb-reader-toc-close" type="button">✕</button>
        </div>
        <div class="vb-reader-toc-list"></div>
      </div>
      <div class="vb-reader-library vb-popover" style="display:none">
        <div class="vb-reader-library-head">
          <div class="vb-reader-library-title">本地书架</div>
          <button class="vb-reader-library-close" type="button">✕</button>
        </div>
        <div class="vb-reader-library-list"></div>
        <div class="vb-reader-library-status"></div>
      </div>
      <div class="vb-reader-bookmarks-popover vb-popover" style="display:none">
        <div class="vb-reader-bookmarks-popover-head">
          <span class="vb-reader-bookmarks-title">书签 <span class="vb-reader-bookmarks-count">0</span></span>
          <button class="vb-reader-bookmarks-popover-close" type="button">✕</button>
        </div>
        <div class="vb-reader-bookmarks-actions">
          <button class="vb-reader-bookmark-add" type="button">添加书签</button>
        </div>
        <div class="vb-reader-bookmarks-list"></div>
      </div>
      <div class="vb-reader-title-row">
        <div class="vb-reader-title">未导入阅读内容</div>
        <div class="vb-reader-title-actions">
          <button class="vb-reader-bookmark-icon" type="button" title="书签">⚑</button>
          <button class="vb-reader-import-icon" type="button" title="导入文件">📄</button>
        </div>
      </div>
      <div class="vb-reader-page">暂无内容</div>
    </div>
    <div class="vb-actions vb-actions-reader">
      <button class="vb-reader-prev" type="button">上一章</button>
      <button class="vb-reader-next" type="button">下一章</button>
    </div>
    <div class="vb-footer vb-footer-reader">
      <span class="vb-reader-meta"></span>
      <span class="vb-reader-percent">全文进度 0%</span>
    </div>
  `;

  panel.addEventListener('click', e => e.stopPropagation());
  document.body.appendChild(panel);

  panel.querySelector('.vb-close')?.addEventListener('click', () => {
    setReaderPanelOpen(false);
  });

  panel.querySelector('.vb-header')?.addEventListener('pointerdown', e => {
    beginDrag(e, panel);
  });

  panel.querySelector('.vb-reader-prev')?.addEventListener('click', () => {
    readerPrev();
  });

  panel.querySelector('.vb-reader-next')?.addEventListener('click', () => {
    readerNext();
  });

  panel.querySelector('.vb-reader-import-icon')?.addEventListener('click', () => {
    openReaderFilePicker();
  });

  panel.querySelector('.vb-reader-remote-btn')?.addEventListener('click', () => {
    readerRemotePopoverOpen = !readerRemotePopoverOpen;
    if (readerRemotePopoverOpen) {
      readerLibraryPopoverOpen = false;
      readerBookmarkPopoverOpen = false;
      readerTocPopoverOpen = false;
    }
    updatePanel();
  });

  panel.querySelector('.vb-reader-library-btn')?.addEventListener('click', () => {
    readerLibraryPopoverOpen = !readerLibraryPopoverOpen;
    if (readerLibraryPopoverOpen) {
      readerRemotePopoverOpen = false;
      readerBookmarkPopoverOpen = false;
      readerTocPopoverOpen = false;
    }
    updatePanel();
  });

  panel.querySelector('.vb-reader-toc-btn')?.addEventListener('click', () => {
    readerTocPopoverOpen = !readerTocPopoverOpen;
    if (readerTocPopoverOpen) {
      readerRemotePopoverOpen = false;
      readerLibraryPopoverOpen = false;
      readerBookmarkPopoverOpen = false;
    }
    updatePanel();
  });

  panel.querySelector('.vb-reader-remote-close')?.addEventListener('click', () => {
    readerRemotePopoverOpen = false;
    updatePanel();
  });

  panel.querySelector('.vb-reader-library-close')?.addEventListener('click', () => {
    readerLibraryPopoverOpen = false;
    updatePanel();
  });

  panel.querySelector('.vb-reader-toc-close')?.addEventListener('click', () => {
    readerTocPopoverOpen = false;
    updatePanel();
  });

  panel.querySelector('.vb-reader-bookmark-icon')?.addEventListener('click', () => {
    readerBookmarkPopoverOpen = !readerBookmarkPopoverOpen;
    if (readerBookmarkPopoverOpen) {
      readerRemotePopoverOpen = false;
      readerLibraryPopoverOpen = false;
      readerTocPopoverOpen = false;
    }
    updatePanel();
  });

  panel.querySelector('.vb-reader-bookmarks-popover-close')?.addEventListener('click', () => {
    readerBookmarkPopoverOpen = false;
    updatePanel();
  });

  panel.querySelector('.vb-reader-bookmark-add')?.addEventListener('click', () => {
    addReaderBookmark();
    flushReaderPosition({ silent: true });
  });

  panel.addEventListener('click', e => {
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (!target) return;

    const libraryOpen = target.closest('[data-library-open]');
    if (libraryOpen instanceof HTMLElement) {
      const id = libraryOpen.dataset.libraryOpen || '';
      if (id) loadReaderLibraryEntry(id);
      return;
    }

    const libraryDelete = target.closest('[data-library-delete]');
    if (libraryDelete instanceof HTMLElement) {
      const id = libraryDelete.dataset.libraryDelete || '';
      if (id) removeReaderLibraryEntry(id);
      return;
    }

    const bookmarkJump = target.closest('[data-bookmark-jump]');
    if (bookmarkJump instanceof HTMLElement) {
      const page = Number(bookmarkJump.dataset.page || 0);
      if (page) jumpToReaderBookmark(page);
      return;
    }

    const bookmarkDelete = target.closest('[data-bookmark-delete]');
    if (bookmarkDelete instanceof HTMLElement) {
      const idx = Number(bookmarkDelete.dataset.index || -1);
      if (Number.isFinite(idx) && idx >= 0) removeReaderBookmark(idx);
    }
  });

  const encodingSelect = panel.querySelector('.vb-reader-encoding-select');
  if (encodingSelect instanceof HTMLSelectElement) {
    encodingSelect.addEventListener('change', () => {
      pluginConfig.readerEncoding = encodingSelect.value;
      saveSettings();
      updatePanel();
    });
  }

  const remoteSourceEl = panel.querySelector('.vb-remote-source');
  if (remoteSourceEl instanceof HTMLSelectElement) {
    remoteSourceEl.addEventListener('change', () => {
      pluginConfig.readerRemoteSourceId = remoteSourceEl.value;
      pluginConfig.readerRemoteChapterUrl = '';
      saveSettings();
      state.remote.sourceId = '';
      state.remote.chapters = [];
      state.remote.error = '';
      loadRemoteIndex({ force: true });
    });
  }

  const remoteChapterEl = panel.querySelector('.vb-remote-chapter');
  if (remoteChapterEl instanceof HTMLSelectElement) {
    remoteChapterEl.addEventListener('change', () => {
      pluginConfig.readerRemoteChapterUrl = remoteChapterEl.value;
      saveSettings();
    });
  }

  panel.querySelector('.vb-remote-refresh')?.addEventListener('click', () => {
    loadRemoteIndex({ force: true });
  });

  panel.querySelector('.vb-remote-load')?.addEventListener('click', () => {
    const target = pluginConfig.readerRemoteChapterUrl;
    if (target) loadRemoteChapter(target);
  });

  /* ---- 滚动：即时记录真实位置，防抖只用于落盘 ---- */
  const pageEl = panel.querySelector('.vb-reader-page');
  if (pageEl instanceof HTMLElement) {
    pageEl.addEventListener('scroll', () => {
      if (!panel.classList.contains('is-open')) return;
      state.reader.savedScrollTop = Math.max(0, pageEl.scrollTop || 0);
      updateReaderPercent();
      scheduleReaderProgressSave();
    }, { passive: true });
  }

  updatePanel();
}

/* ========================= 设置面板 ========================= */

function createSettingsInterface() {
  if (document.getElementById('vocab-break-settings')) return;
  const container = document.getElementById('extensions_settings');
  if (!container) return;

  const root = document.createElement('div');
  root.id = 'vocab-break-settings';
  root.className = 'inline-drawer';
  root.innerHTML = `
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>阅读小窗</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div class="extension-content flex flexFlowColumn gap10px">
        <div class="extension-content-item box-container">
          <div class="settings-title">
            <div class="settings-title-text">启用阅读小窗</div>
            <div class="settings-title-description">关闭后隐藏阅读悬浮按钮与面板</div>
          </div>
          <label class="toggle">
            <input id="${MODULE_NAME}_enable_reader" type="checkbox" class="toggle-input" ${pluginConfig.enableReader ? 'checked' : ''} />
            <span class="toggle-label"></span>
          </label>
        </div>

        <div class="extension-content-item box-container">
          <div class="settings-title">
            <div class="settings-title-text">阅读面板</div>
            <div class="settings-title-description">手动打开/关闭阅读浮窗</div>
          </div>
          <div class="vb-inline">
            <button class="menu_button" id="${MODULE_NAME}_reader_open">打开面板</button>
            <button class="menu_button" id="${MODULE_NAME}_reader_close">关闭面板</button>
          </div>
        </div>

        <div class="extension-content-item box-container">
          <div class="settings-title">
            <div class="settings-title-text">阅读面板尺寸</div>
            <div class="settings-title-description">调整阅读小窗宽高</div>
          </div>
          <div class="vb-inline">
            <span>宽</span>
            <input id="${MODULE_NAME}_reader_width" type="range" min="260" max="760" step="10" value="${Number(pluginConfig.readerPanelWidth) || 360}" />
            <span id="${MODULE_NAME}_reader_width_val">${Number(pluginConfig.readerPanelWidth) || 360}</span>
          </div>
          <div class="vb-inline" style="margin-top: 6px;">
            <span>高</span>
            <input id="${MODULE_NAME}_reader_height" type="range" min="360" max="1000" step="10" value="${Number(pluginConfig.readerPanelHeight) || 520}" />
            <span id="${MODULE_NAME}_reader_height_val">${Number(pluginConfig.readerPanelHeight) || 520}</span>
          </div>
        </div>

        <div class="extension-content-item box-container">
          <div class="settings-title">
            <div class="settings-title-text">阅读排版</div>
            <div class="settings-title-description">字体、行距与段间距</div>
          </div>
          <div class="vb-inline">
            <span>字体</span>
            <input id="${MODULE_NAME}_reader_font" type="range" min="12" max="22" step="1" value="${Number(pluginConfig.readerFontSize) || 14}" />
            <span id="${MODULE_NAME}_reader_font_val">${Number(pluginConfig.readerFontSize) || 14}</span>
          </div>
          <div class="vb-inline" style="margin-top: 6px;">
            <span>行距</span>
            <input id="${MODULE_NAME}_reader_line" type="range" min="1.2" max="2.0" step="0.1" value="${Number(pluginConfig.readerLineHeight) || 1.6}" />
            <span id="${MODULE_NAME}_reader_line_val">${Number(pluginConfig.readerLineHeight) || 1.6}</span>
          </div>
          <div class="vb-inline" style="margin-top: 6px;">
            <span>段间距</span>
            <input id="${MODULE_NAME}_reader_paragraph_gap" type="range" min="0" max="40" step="2" value="${Number(pluginConfig.readerParagraphSpacing) || 16}" />
            <span id="${MODULE_NAME}_reader_paragraph_gap_val">${Number(pluginConfig.readerParagraphSpacing) || 16}</span>
          </div>
        </div>

        <div class="extension-content-item box-container">
          <div class="settings-title">
            <div class="settings-title-text">TXT 编码</div>
            <div class="settings-title-description">仅对 TXT 有效，自动识别适用于常见编码</div>
          </div>
          <div class="vb-inline">
            <select id="${MODULE_NAME}_reader_encoding">
              ${TEXT_ENCODINGS.map(encoding => `<option value="${encoding.id}">${encoding.label}</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="extension-content-item box-container">
          <div class="settings-title">
            <div class="settings-title-text">阅读文件</div>
            <div class="settings-title-description">导入 TXT/PDF/EPUB，或清空当前内容</div>
          </div>
          <div class="vb-inline">
            <button class="menu_button" id="${MODULE_NAME}_reader_import">导入文件</button>
            <button class="menu_button" id="${MODULE_NAME}_reader_clear">清空阅读内容</button>
          </div>
        </div>

        <div class="extension-content-item box-container">
          <div class="settings-title">
            <div class="settings-title-text">保留章节阅读位置</div>
            <div class="settings-title-description">关闭面板或切换书籍后，再次打开回到上次的滚动位置</div>
          </div>
          <label class="toggle">
            <input id="${MODULE_NAME}_reader_keep_scroll" type="checkbox" class="toggle-input" ${pluginConfig.readerKeepScroll ? 'checked' : ''} />
            <span class="toggle-label"></span>
          </label>
        </div>
      </div>
    </div>
  `;

  container.appendChild(root);

  const drawerContent = root.querySelector('.inline-drawer-content');
  const drawerIcon = root.querySelector('.inline-drawer-icon');
  if (drawerContent && drawerIcon && pluginConfig.settingsOpen) {
    drawerIcon.classList.remove('down', 'fa-circle-chevron-down');
    drawerIcon.classList.add('up', 'fa-circle-chevron-up');
    drawerContent.style.display = 'block';
  }

  const encodingSelect = root.querySelector(`#${MODULE_NAME}_reader_encoding`);
  if (encodingSelect) encodingSelect.value = pluginConfig.readerEncoding;

  root.addEventListener('input', e => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;

    if (t.id === `${MODULE_NAME}_enable_reader`) {
      pluginConfig.enableReader = t.checked;
      if (!pluginConfig.enableReader) setReaderPanelOpen(false);
      saveSettings();
      updatePanel();
      return;
    }

    if (t.id === `${MODULE_NAME}_reader_width`) {
      const v = parseInt(t.value, 10);
      pluginConfig.readerPanelWidth = Number.isFinite(v) ? v : DEFAULT_CONFIG.readerPanelWidth;
      const out = document.getElementById(`${MODULE_NAME}_reader_width_val`);
      if (out) out.textContent = String(pluginConfig.readerPanelWidth);
      saveSettings();
      applyPanelSizing();
      applyFloatingPositions();
      return;
    }

    if (t.id === `${MODULE_NAME}_reader_height`) {
      const v = parseInt(t.value, 10);
      pluginConfig.readerPanelHeight = Number.isFinite(v) ? v : DEFAULT_CONFIG.readerPanelHeight;
      const out = document.getElementById(`${MODULE_NAME}_reader_height_val`);
      if (out) out.textContent = String(pluginConfig.readerPanelHeight);
      saveSettings();
      applyPanelSizing();
      applyFloatingPositions();
      return;
    }

    if (t.id === `${MODULE_NAME}_reader_font`) {
      const v = parseInt(t.value, 10);
      pluginConfig.readerFontSize = Number.isFinite(v) ? v : 14;
      const out = document.getElementById(`${MODULE_NAME}_reader_font_val`);
      if (out) out.textContent = String(pluginConfig.readerFontSize);
      saveSettings();
      updatePanel();
      return;
    }

    if (t.id === `${MODULE_NAME}_reader_line`) {
      const v = parseFloat(t.value);
      pluginConfig.readerLineHeight = Number.isFinite(v) ? v : 1.6;
      const out = document.getElementById(`${MODULE_NAME}_reader_line_val`);
      if (out) out.textContent = String(pluginConfig.readerLineHeight);
      saveSettings();
      updatePanel();
      return;
    }

    if (t.id === `${MODULE_NAME}_reader_paragraph_gap`) {
      const v = parseInt(t.value, 10);
      pluginConfig.readerParagraphSpacing = Number.isFinite(v) ? v : 16;
      const out = document.getElementById(`${MODULE_NAME}_reader_paragraph_gap_val`);
      if (out) out.textContent = String(pluginConfig.readerParagraphSpacing);
      saveSettings();
      updatePanel();
      return;
    }

    if (t.id === `${MODULE_NAME}_reader_encoding`) {
      pluginConfig.readerEncoding = t.value;
      saveSettings();
      updatePanel();
      return;
    }

    if (t.id === `${MODULE_NAME}_reader_keep_scroll`) {
      pluginConfig.readerKeepScroll = t.checked;
      saveSettings();
    }
  });

  root.addEventListener('click', e => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;

    if (t.id === `${MODULE_NAME}_reader_open`) {
      e.preventDefault();
      setReaderPanelOpen(true);
      return;
    }

    if (t.id === `${MODULE_NAME}_reader_close`) {
      e.preventDefault();
      setReaderPanelOpen(false);
      return;
    }

    if (t.id === `${MODULE_NAME}_reader_import`) {
      e.preventDefault();
      openReaderFilePicker();
      return;
    }

    if (t.id === `${MODULE_NAME}_reader_clear`) {
      e.preventDefault();
      clearReaderText();
      toastr?.success?.('已清空阅读内容。', '阅读小窗');
    }
  });

  root.addEventListener('inline-drawer-toggle', () => {
    const content = root.querySelector('.inline-drawer-content');
    if (!content) return;
    setTimeout(() => {
      const isOpen = getComputedStyle(content).display !== 'none';
      pluginConfig.settingsOpen = isOpen;
      saveSettings();
    }, 0);
  });
}

/* ========================= 初始化 ========================= */

function init() {
  initConfig();
  pageRenderKey = '';

  void loadReaderFromStorage();
  void loadReaderLibrary();
  ensureReaderFileInput();
  ensureReaderBar();
  ensureReaderPanel();
  bindDragEvents();
  createSettingsInterface();

  const ctx = getContext();
  ctx.eventSource.on(ctx.eventTypes.EXTENSION_SETTINGS_LOADED, () => createSettingsInterface());
  ctx.eventSource.on(ctx.eventTypes.EXTENSIONS_FIRST_LOAD, () => createSettingsInterface());

  state.remote.sourceId = pluginConfig.readerRemoteSourceId;
  state.remote.selectedUrl = pluginConfig.readerRemoteChapterUrl;
  updatePanel();
}

$(document).ready(() => init());
