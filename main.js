// 启动性能优化：只加载启动必需的模块，其他惰性加载
const { app, BrowserWindow, session, net } = require('electron');
const path = require('path');

// 版本号统一从 package.json 读取，避免与安装包版本不一致
let APP_VERSION = '1.6.2';
try { APP_VERSION = require(path.join(__dirname, 'package.json')).version || APP_VERSION; } catch (e) {}

// === 检测是否是便携版（免装版）===
let isPortable = false;
try {
  const fs = require('fs');
  const portableMarker = path.join(process.execPath, '../', 'Portable.exe');
  isPortable = process.argv.some(arg => arg.toLowerCase().includes('portable')) || fs.existsSync(portableMarker);
} catch(e) {}

// === 内置智谱 GLM-4.7 API（作者提供）：用户未配置任何智谱 Key 时自动兜底联网可用，
// === 无需用户填写 Key 或下载 1.1GB 本地模型。GLM-4.7-Flash 永久免费。
const EMBED_ZHIPU = {
  key: '78aaf862f9ff4870bbdcaf78d093cf37.KiIEtLTixbaggoPi',
  // 均为永久免费且会输出思考过程（reasoning_content）的模型：
  // 4.7-flash 优先，失败依次降级到 4.6v-flash、4.5-flash。
  // 刻意不放入 glm-4-flash——它不返回思考过程，会让「AI 思考过程」区块空白。
  models: ['glm-4.7-flash', 'glm-4.6v-flash', 'glm-4.5-flash']
};

// 判断某错误是否属于“内置 API 免费额度/配额用尽”类。
// 刻意不把裸 429 算进来——429 绝大多数是「该模型当前访问量过大」这种临时限流，
// 稍后重试或换个模型就行；报成「额度已用完」会误导用户跑去换密钥。
function isQuotaError(text) {
  if (!text) return false;
  return /(quota|insufficient|no enough|402|too many|额度|余额|耗尽|免费配额|欠费|balance)/i.test(text);
}

// 把服务端的错误响应压成一句人话（「该模型当前访问量过大」「余额不足」…），
// 而不是把整段原始 JSON 抖到界面上给用户看。
function describeHttpBody(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  try {
    const o = JSON.parse(s);
    const m = (o && o.error && (o.error.message || o.error.code)) || (o && o.message);
    if (m) return '：' + m;
  } catch (e) {}
  return '：' + s.slice(0, 120);
}

// === 记住「上一次真正出字的模型」===
// 内置模型经常撞上「该模型当前访问量过大」，把上次成功的那个排到最前面，
// 下次就不用再从被限流的模型开始白等一轮。
let _aiPrefModel = null;
function aiPrefFile() { return path.join(app.getPath('userData'), 'ai_pref.json'); }
function loadAiPrefModel() {
  if (_aiPrefModel !== null) return _aiPrefModel;
  try {
    const o = JSON.parse(lazyFs().readFileSync(aiPrefFile(), 'utf8'));
    _aiPrefModel = (o && typeof o.model === 'string') ? o.model : '';
  } catch (e) { _aiPrefModel = ''; }
  return _aiPrefModel;
}
function saveAiPrefModel(model) {
  if (!model) return;
  _aiPrefModel = model;
  try { lazyFs().writeFileSync(aiPrefFile(), JSON.stringify({ model: model }), 'utf8'); } catch (e) {}
}

// === 启动性能优化：尽早设置命令行开关 ===
// 禁用 GPU 进程的一些不必要功能，加快启动
app.commandLine.appendSwitch('--disable-gpu-compositing');
app.commandLine.appendSwitch('--disable-software-rasterizer');
// 禁用不必要的后台线程
app.commandLine.appendSwitch('--disable-background-timer-throttling');
// 加快 V8 编译
app.commandLine.appendSwitch('--js-flags', '--max-old-space-size=512');

// === 禁用安全警告（生产环境）===
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

let mainWindow = null;
let currentChild = null;
let currentRunId = 0;
let compilerCache = null;

// === 惰性加载模块（首次使用时才 require）===
let _ipcMain, _dialog, _fs, _os, _child_process, _https, _http;
function lazyIp() { return _ipcMain || (_ipcMain = require('electron').ipcMain); }
function lazyDialog() { return _dialog || (_dialog = require('electron').dialog); }
function lazyFs() { return _fs || (_fs = require('fs')); }
function lazyOs() { return _os || (_os = require('os')); }
function lazyCp() { return _child_process || (_child_process = require('child_process')); }
function lazyHttps() { return _https || (_https = require('https')); }
function lazyHttp() { return _http || (_http = require('http')); }

// === 连接复用：keep-alive Agent，避免每次请求重复 TCP/TLS 握手 ===
let _httpsAgent, _httpAgent;
function lazyHttpsAgent() {
  if (!_httpsAgent) {
    _httpsAgent = new (require('https').Agent)({ keepAlive: true, maxSockets: 8, keepAliveMsecs: 60000 });
  }
  return _httpsAgent;
}
function lazyHttpAgent() {
  if (!_httpAgent) {
    _httpAgent = new (require('http').Agent)({ keepAlive: true, maxSockets: 8, keepAliveMsecs: 60000 });
  }
  return _httpAgent;
}

// === 内置本地大模型（llama.cpp + Qwen GGUF，离线免费）===
const LOCAL_LLM_PORT = 17821;
const localLLM = {
  state: 'idle',   // idle | starting | running | failed | stopped
  proc: null,
  exePath: null,
  modelPath: null,
  startError: '',
  _pending: null,

  // 资源根目录：优先「用户下载安装的模型目录」，其次开发缓存 / 旧版内置打包
  resourceRoot() {
    const fs = lazyFs();
    const candidates = [
      path.join(app.getPath('userData'), 'ai'), // 用户通过下载器安装到此
      path.join(__dirname, 'dev-ai'),           // 开发缓存（不打进安装包）
      process.resourcesPath,                    // 旧版：打包内置 extraResources
      path.join(__dirname, 'resources')
    ];
    for (const dir of candidates) {
      try {
        if (fs.existsSync(path.join(dir, 'llama')) && fs.existsSync(path.join(dir, 'models'))) {
          return dir;
        }
      } catch (e) {}
    }
    return candidates[0];
  },

  // 是否已安装模型（llama 引擎 + gguf 模型都齐备）
  available() {
    try {
      const fs = lazyFs();
      const root = this.resourceRoot();
      const modelsDir = path.join(root, 'models');
      const llamaDir = path.join(root, 'llama');
      if (!fs.existsSync(modelsDir) || !fs.existsSync(llamaDir)) return false;
      const hasModel = fs.readdirSync(modelsDir).some(f => f.toLowerCase().endsWith('.gguf'));
      if (!hasModel) return false;
      return fs.existsSync(path.join(llamaDir, 'cpu', 'llama-server.exe'));
    } catch (e) { return false; }
  },

  isRunning() {
    return this.state === 'running';
  },

  // 确保本地服务已启动；返回 Promise<boolean>
  ensureStarted() {
    if (this.state === 'running') return Promise.resolve(true);
    if (this.state === 'starting' && this._pending) return this._pending;
    if (!this.available()) {
      this.state = 'failed';
      this.startError = '未找到内置模型文件';
      return Promise.resolve(false);
    }
    this.state = 'starting';
    this._pending = this._doStart();
    return this._pending;
  },

  async _doStart() {
    const fs = lazyFs();
    const { spawn } = lazyCp();
    const root = this.resourceRoot();
    const llamaDir = path.join(root, 'llama');

    // 找模型
    const modelsDir = path.join(root, 'models');
    let modelFile = null;
    try {
      modelFile = fs.readdirSync(modelsDir).find(f => f.toLowerCase().endsWith('.gguf'));
    } catch (e) {}
    if (!modelFile) { this.state = 'failed'; this.startError = '未找到内置模型文件'; return false; }
    this.modelPath = path.join(modelsDir, modelFile);

    // 引擎候选：优先 Vulkan（可调用 Intel/NVIDIA 显卡加速），失败自动退回 CPU 版
    const candidates = ['vulkan', 'cpu'];
    for (const kind of candidates) {
      const exe = path.join(llamaDir, kind, 'llama-server.exe');
      if (!fs.existsSync(exe)) continue;
      this.exePath = exe;
      const started = await this._spawnAndWait(fs, spawn);
      if (started) { this.state = 'running'; this.startError = ''; return true; }
    }
    this.state = 'failed';
    return false;
  },

  _spawnAndWait(fs, spawn) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok, msg) => { if (!settled) { settled = true; resolve(ok); } };

      let proc;
      try {
        proc = spawn(this.exePath, [
          '-m', this.modelPath,
          '--port', String(LOCAL_LLM_PORT),
          '--host', '127.0.0.1',
          '-c', '2048',
          '--threads', '0'
        ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (e) { this.startError = '启动失败: ' + e.message; finish(false); return; }

      this.proc = proc;
      let errTail = '';
      if (proc.stderr) {
        proc.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-500); });
      }
      proc.on('error', (e) => { this.startError = '启动错误: ' + e.message; finish(false); });
      proc.on('exit', (code) => {
        // 进程退出
        if (this.state !== 'stopped') {
          this.startError = '进程退出(code=' + code + '): ' + errTail.split('\n').pop();
        }
        this.proc = null;
        finish(false);
      });

      // 轮询健康检查（模型加载通常 3~10 秒）
      let waited = 0;
      const timer = setInterval(() => {
        waited += 500;
        if (waited > 60000) {
          clearInterval(timer);
          this.startError = '启动超时: ' + errTail.split('\n').pop();
          try { proc.kill(); } catch (e) {}
          finish(false);
          return;
        }
        this._healthCheck().then((ok) => {
          if (ok) { clearInterval(timer); finish(true); }
        });
      }, 500);
    });
  },

  _healthCheck() {
    return new Promise((resolve) => {
      const http = lazyHttp();
      const req = http.request({ hostname: '127.0.0.1', port: LOCAL_LLM_PORT, path: '/health', method: 'GET', timeout: 2000 }, (res) => {
        let d = '';
        res.on('data', (c) => d += c);
        res.on('end', () => {
          try { const j = JSON.parse(d); resolve(!!(j && (j.status === 'ok' || j.status === 'loading model'))); }
          catch (e) { resolve(false); }
        });
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
  },

  stop() {
    this.state = 'stopped';
    if (this.proc) {
      try { this.proc.kill(); } catch (e) {}
      this.proc = null;
    }
  }
};

// === 内置 AI 模型下载器（引擎 + 模型分卷，蓝奏云）===
// 分卷上传到蓝奏云后，把每卷的分享页链接和密码填进 AI_DOWNLOAD_SOURCES
const AI_MODEL_FILENAME = 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf';
const AI_ENGINE_ZIP = 'cpp-ai-engine.zip';
let aiDownloadRunning = false;

// 【已填】蓝奏云上传物清单（顺序下载）。
// { type: 'lanzou', url, pwd, saveAs }：lanzou 链接需在应用内用隐藏窗口解析（蓝奏云有 JS 反爬）；
// 模型分卷为真 zip（普通压缩），saveAs 用 'qwen15b-gguf.part01.zip' ~ 'part12.zip'，下载后会自动解包再拼接
const AI_DOWNLOAD_SOURCES = [
  // 引擎包（无密码；2026-09-06 用户重新上传的新链接）
  { type: 'lanzou', url: 'https://wwapu.lanzouq.com/ieATs470o24h', pwd: '', saveAs: 'cpp-ai-engine.zip' },
  // 模型分卷 01~12（无密码；顺序已核验：链接1→model-01.zip … 链接12→model-12.zip）
  { type: 'lanzou', url: 'https://wwapu.lanzouq.com/ifQPC470iemb', pwd: '', saveAs: 'qwen15b-gguf.part01.zip' },
  { type: 'lanzou', url: 'https://wwapu.lanzouq.com/infXI470igde', pwd: '', saveAs: 'qwen15b-gguf.part02.zip' },
  { type: 'lanzou', url: 'https://wwapu.lanzouq.com/iMUOo470iipi', pwd: '', saveAs: 'qwen15b-gguf.part03.zip' },
  { type: 'lanzou', url: 'https://wwapu.lanzouq.com/i7GjZ470ik2h', pwd: '', saveAs: 'qwen15b-gguf.part04.zip' },
  { type: 'lanzou', url: 'https://wwapu.lanzouq.com/iDrYU470im0h', pwd: '', saveAs: 'qwen15b-gguf.part05.zip' },
  { type: 'lanzou', url: 'https://wwapu.lanzouq.com/iU3qR470ipsd', pwd: '', saveAs: 'qwen15b-gguf.part06.zip' },
  { type: 'lanzou', url: 'https://wwapu.lanzouq.com/ip7D8470iwjg', pwd: '', saveAs: 'qwen15b-gguf.part07.zip' },
  { type: 'lanzou', url: 'https://wwapu.lanzouq.com/ib728470j3dc', pwd: '', saveAs: 'qwen15b-gguf.part08.zip' },
  { type: 'lanzou', url: 'https://wwapu.lanzouq.com/iIho5470j8gf', pwd: '', saveAs: 'qwen15b-gguf.part09.zip' },
  { type: 'lanzou', url: 'https://wwapu.lanzouq.com/iOQ3n470jdmb', pwd: '', saveAs: 'qwen15b-gguf.part10.zip' },
  { type: 'lanzou', url: 'https://wwapu.lanzouq.com/iRKiz470jh1e', pwd: '', saveAs: 'qwen15b-gguf.part11.zip' },
  { type: 'lanzou', url: 'https://wwapu.lanzouq.com/i0AwF470jjlg', pwd: '', saveAs: 'qwen15b-gguf.part12.zip' }
];
const AI_DOWNLOAD_PLAN = {
  engineZipName: AI_ENGINE_ZIP,
  modelName: AI_MODEL_FILENAME,
  modelTotalBytes: 1117320768,
  modelPartNames: [],
  // 启动时由 AI_DOWNLOAD_SOURCES 推导
  parts: []
};

// 开发/测试钩子：CPP_AI_DL_TEST=http://127.0.0.1:PORT 时，从本地服务器下载（不填则不启用）
if (process.env.CPP_AI_DL_TEST) {
  const base = process.env.CPP_AI_DL_TEST.replace(/\/+$/, '');
  AI_DOWNLOAD_SOURCES.length = 0; // 测试时全部走本地，避免误用真实链接
  AI_DOWNLOAD_SOURCES.push({ type: 'direct', url: base + '/cpp-ai-engine.zip', saveAs: AI_ENGINE_ZIP });
  for (let i = 1; i <= 12; i++) {
    const n = 'qwen15b-gguf.part' + String(i).padStart(2, '0') + '.zip';
    AI_DOWNLOAD_SOURCES.push({ type: 'direct', url: base + '/' + n, saveAs: n });
  }
  console.log('[ai-dl] 测试模式：从 ' + base + ' 下载分卷');
}

function aiInstallDir() {
  return path.join(app.getPath('userData'), 'ai');
}

// ---- HTTP GET 文本（支持重定向 / UA / Referer）----
function httpGetText(url, referer, timeoutMs) {
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(url);
      const lib = parsed.protocol === 'https:' ? lazyHttps() : lazyHttp();
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
      };
      if (referer) headers['Referer'] = referer;
      const req = lib.request({
        hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search, method: 'GET', headers: headers,
        agent: parsed.protocol === 'https:' ? lazyHttpsAgent() : lazyHttpAgent()
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = new URL(res.headers.location, url).toString();
          resolve(httpGetText(next, referer, timeoutMs));
          return;
        }
        let d = '';
        res.setEncoding('utf8');
        res.on('data', (c) => d += c);
        res.on('end', () => resolve({ status: res.statusCode, body: d, finalUrl: url }));
      });
      req.on('error', (e) => reject(e));
      req.setTimeout(timeoutMs || 20000, () => { req.destroy(); reject(new Error('超时')); });
      req.end();
    } catch (e) { reject(e); }
  });
}

// ---- 蓝奏云分享页解析：返回 { directUrl, fileName, referer } ----
async function resolveLanzou(url, pwd) {
  const shareHost = new URL(url).host;
  const referer = 'https://' + shareHost + '/';
  // 1. 访问分享页
  const page = await httpGetText(url, referer, 20000);
  let html = page.body;
  // 需要密码：先尝试直接解析；若命中 pwd-tips 说明要密码（新版多为无密码或带?pwd=）
  if (pwd && html.indexOf('输入密码') >= 0) {
    const pwdUrl = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'pwd=' + encodeURIComponent(pwd);
    const p2 = await httpGetText(pwdUrl, referer, 20000);
    html = p2.body;
  }
  // 2. 常见结构A：iframe 指向文件页
  let m = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
  let frameUrl = null;
  if (m && m[1]) {
    frameUrl = m[1].indexOf('http') === 0 ? m[1] : 'https://' + shareHost + m[1];
    // 若 iframe 就是下载器页，通常拿不到直链，仍需 fn 接口
  }
  // 3. 常见结构B：页面内嵌 data 里的下载参数
  const fid = (html.match(/data-fid="?(\d+)"?/) || html.match(/fid['":=]+\s*['"]?(\d+)/) || [])[1];
  const uid = (html.match(/data-uid="?(\d+)"?/) || html.match(/uid['":=]+\s*['"]?(\d+)/) || [])[1];
  // 4. 尝试 fn 接口（新版蓝奏云：/fn?fid&uid 需要 sign，先试直接 GET 经典接口）
  if (fid && uid) {
    try {
      const fn = await httpGetText('https://' + shareHost + '/fn?fid=' + fid + '&uid=' + uid + '&pg=1', referer, 20000);
      const j = JSON.parse(fn.body);
      if (j && j.dom && j.url) {
        return { directUrl: j.dom + '/file/' + j.url, fileName: j.name || '', referer: 'https://' + shareHost + '/' };
      }
    } catch (e) {}
  }
  // 5. 直接结构：页面有 data-url / down_url / 下载按钮链接
  m = html.match(/(?:data-url|down_url|url)\s*[:=]\s*["'](https?:\/\/[^"']+)["']/i);
  if (m) return { directUrl: m[1], fileName: '', referer: referer };
  // 6. 页面中存在 a 标签指向真实文件域
  const anchors = html.match(/<a[^>]+href=["'](https?:\/\/[^"']+?)["'][^>]*>/g) || [];
  for (const a of anchors) {
    const href = (a.match(/href=["']([^"']+)["']/) || [])[1];
    if (href && /(file|lanzou[a-z]*\.|d\.)/i.test(href) && href.indexOf('wwa') < 0) {
      return { directUrl: href, fileName: '', referer: referer };
    }
  }
  throw new Error('无法解析蓝奏云链接，请换用直链模式');
}

// ---- 下载单个文件到本地（支持 302 与进度回调）----
function downloadToFile(url, destPath, referer, onProgress) {
  return new Promise((resolve, reject) => {
    const fs = lazyFs();
    try {
      const parsed = new URL(url);
      const lib = parsed.protocol === 'https:' ? lazyHttps() : lazyHttp();
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': '*/*'
      };
      if (referer) headers['Referer'] = referer;
      const req = lib.request({
        hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search, method: 'GET', headers: headers,
        agent: parsed.protocol === 'https:' ? lazyHttpsAgent() : lazyHttpAgent()
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = new URL(res.headers.location, url).toString();
          resolve(downloadToFile(next, destPath, referer, onProgress));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error('HTTP ' + res.statusCode));
          return;
        }
        const ws = fs.createWriteStream(destPath);
        const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
        let got = 0;
        res.on('data', (c) => { got += c.length; if (onProgress && total) onProgress(got, total); });
        res.pipe(ws);
        ws.on('finish', () => { ws.close(); resolve({ bytes: got }); });
        ws.on('error', (e) => { try { ws.close(); } catch (_) {} reject(e); });
      });
      req.on('error', reject);
      req.setTimeout(120000, () => { req.destroy(); reject(new Error('下载超时')); });
      req.end();
    } catch (e) { reject(e); }
  });
}

// ---- 用系统 tar 解压 zip（Windows 10 1803+ 自带 tar.exe）----
function extractZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const { execFile } = lazyCp();
    lazyFs().mkdirSync(destDir, { recursive: true });
    execFile('tar.exe', ['-xf', zipPath, '-C', destDir], { windowsHide: true, timeout: 120000 }, (err) => {
      if (err) reject(new Error('解压失败: ' + (err.message || '')));
      else resolve(true);
    });
  });
}

// ---- 发送下载进度到渲染进程 ----
function aiProgress(payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ai-model-progress', payload);
    }
  } catch (e) {}
}

// ---- 隐藏窗口：蓝奏云分享页解析（自动执行 JS 反爬挑战，返回真实文件直链）----
let _lzWin = null;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function lzWindow() {
  if (_lzWin && !_lzWin.isDestroyed()) return _lzWin;
  const w = new BrowserWindow({
    show: false,
    width: 900,
    height: 640,
    webPreferences: { sandbox: false }
  });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.on('closed', () => { _lzWin = null; });
  _lzWin = w;
  return w;
}

function closeLzWindow() {
  try { if (_lzWin && !_lzWin.isDestroyed()) _lzWin.destroy(); } catch (e) {}
  _lzWin = null;
}

async function lzEval(js) {
  const w = await lzWindow();
  return w.webContents.executeJavaScript(js, true);
}

async function lzWaitFor(predJs, timeoutMs) {
  const start = Date.now();
  let lastErr = '';
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await lzEval(predJs);
      if (v) return v;
    } catch (e) { lastErr = e.message; }
    await sleepMs(600);
  }
  throw new Error('蓝奏云页面加载超时' + (lastErr ? '：' + lastErr : ''));
}

async function resolveLanzouShare(url, pwd) {
  const shareHost = new URL(url).host;
  const referer = 'https://' + shareHost + '/';
  const w = await lzWindow();
  const wc = w.webContents;

  // 1) 打开分享页（Chromium 自动执行 JS 反爬挑战并刷新）
  await wc.loadURL(url).catch(() => {});
  const first = await lzWaitFor(`(function(){
    var body = (document.body ? document.body.innerText : '');
    if (/取消分享|来晚啦|已删除|不存在/.test(body)) return { err: body.replace(/\\s+/g, ' ').slice(0, 80) };
    var f = document.querySelector('iframe');
    if (f && f.src) return { err: '', frameSrc: f.src };
    var inp = document.querySelector('input[type=password], input[placeholder*=提取码], input[placeholder*=密码]');
    if (inp) return { err: '', needPwd: true, frameSrc: '' };
    return { err: '', needPwd: false, frameSrc: '' };
  })()`, 35000);
  if (first.err) throw new Error('蓝奏云链接失效：' + first.err);
  let frameSrc = first.frameSrc || '';
  if (!frameSrc && first.needPwd) {
    if (!pwd) throw new Error('该蓝奏云链接需要提取码，请在配置中填写');
    await lzEval(`(function(){
      var inp = document.querySelector('input[type=password], input[placeholder*=提取码], input[placeholder*=密码]');
      if (inp) {
        var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, ${JSON.stringify(pwd)});
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }
      var btn = Array.prototype.find.call(document.querySelectorAll('button, a, input[type=button], input[type=submit], .btn, [class*=btn]'), function(el){
        return /确\\s*定|提\\s*交|访问/.test(el.textContent || '') && el.offsetParent !== null;
      });
      if (btn) btn.click();
    })()`);
    await sleepMs(1500);
    const after = await lzWaitFor(`(function(){
      var f = document.querySelector('iframe');
      if (f && f.src) return { frameSrc: f.src, err: '' };
      var body = (document.body ? document.body.innerText : '');
      return { frameSrc: '', err: /密码|提取码|错误/.test(body) ? '提取码可能不正确' : '' };
    })()`, 15000);
    if (after.err) throw new Error('蓝奏云提取码验证失败：' + after.err);
    frameSrc = after.frameSrc || '';
  }
  if (!frameSrc) throw new Error('未能获取蓝奏云下载页，请确认链接有效');

  // 2) 打开下载页(fn)，等“下载”链接出现拿到真实文件地址
  const frameUrl = frameSrc.indexOf('http') === 0 ? frameSrc : 'https://' + shareHost + frameSrc;
  await wc.loadURL(frameUrl).catch(() => {});
  const dl = await lzWaitFor(`(function(){
    var body = (document.body ? document.body.innerText : '');
    if (body.indexOf('地址超时') >= 0) return 'expired';
    var links = Array.prototype.map.call(document.querySelectorAll('a'), function(a){ return a.href || ''; });
    for (var i = 0; i < links.length; i++) {
      if (/(lanrar\\.com\\/file|\\/file\\/)/.test(links[i])) return links[i];
    }
    return '';
  })()`, 35000);
  if (dl === 'expired') throw new Error('蓝奏云下载地址已过期，请重试');
  if (!dl) throw new Error('蓝奏云下载页未返回下载地址');
  return { directUrl: dl, referer: referer, fileName: '' };
}

// ---- 基于 Electron net 的流式下载（Chromium 网络栈，行为接近真实浏览器）----
async function downloadNet(url, destPath, referer, onProgress) {
  const fs = lazyFs();
  const resp = await net.fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Accept': '*/*',
      ...(referer ? { 'Referer': referer } : {})
    }
  });
  if (!resp.ok) throw new Error('下载失败 HTTP ' + resp.status);
  const total = parseInt(resp.headers.get('content-length') || '0', 10) || 0;
  const ws = fs.createWriteStream(destPath);
  const reader = resp.body.getReader();
  let got = 0;
  return new Promise((resolve, reject) => {
    ws.on('error', (e) => { try { reader.cancel(); } catch (_) {} reject(e); });
    (async () => {
      try {
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          if (r.value && r.value.length) {
            const b = Buffer.from(r.value);
            if (!ws.write(b)) await new Promise((r2) => ws.once('drain', r2));
            got += b.length;
            if (onProgress) onProgress(got, total || got);
          }
        }
        ws.end();
        await new Promise((r2) => ws.on('finish', r2));
        resolve({ bytes: got });
      } catch (e) {
        try { ws.destroy(); } catch (_) {}
        reject(e);
      }
    })();
  });
}

// ---- 通过 Chromium 下载栈保存文件（与浏览器点击下载一致，可绕过 CDN 对脚本请求的限制）----
async function downloadChromium(url, destPath, onProgress) {
  const fs = lazyFs();
  const w = await lzWindow();
  const ses = w.webContents.session;
  return new Promise((resolve, reject) => {
    let timer = null;
    const onWill = (e, item) => {
      try { item.setSavePath(destPath); } catch (_) {}
      item.on('updated', () => {
        const g = item.getReceivedBytes();
        const t = item.getTotalBytes() || g;
        if (onProgress) onProgress(g, t);
      });
      item.once('done', (ev, state) => {
        clearTimeout(timer);
        ses.removeListener('will-download', onWill);
        if (state === 'completed') resolve({ bytes: item.getReceivedBytes() });
        else reject(new Error('下载失败 state=' + state));
      });
    };
    ses.once('will-download', onWill);
    timer = setTimeout(() => { ses.removeListener('will-download', onWill); reject(new Error('下载超时')); }, 600000);
    w.webContents.downloadURL(url);
  });
}

// ---- 执行整体下载：引擎 → 各分卷拼接 → 完成 ----
async function runAiModelDownload(progressCb) {
  const fs = lazyFs();
  const installDir = aiInstallDir();
  const llamaDir = path.join(installDir, 'llama');
  const modelsDir = path.join(installDir, 'models');
  fs.mkdirSync(installDir, { recursive: true });
  fs.mkdirSync(llamaDir, { recursive: true });
  fs.mkdirSync(modelsDir, { recursive: true });

  const tmpDir = path.join(installDir, '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  // 单个文件下载前才解析（蓝奏云直链有时效性，不能提前全部解析）
  const getResolved = async (s) => {
    if (s.type === 'direct') return { saveAs: s.saveAs, directUrl: s.url, referer: '' };
    const r = await resolveLanzouShare(s.url, s.pwd || '');
    return { saveAs: s.saveAs, directUrl: r.directUrl, referer: r.referer || '' };
  };

  const totalBytes = AI_DOWNLOAD_PLAN.modelTotalBytes;
  let doneBytes = 0;

  try {
    // 1. 引擎 zip
    const engineCfg = AI_DOWNLOAD_SOURCES.find((x) => x.saveAs === AI_ENGINE_ZIP);
    if (!engineCfg) throw new Error('未配置引擎下载源');
    progressCb({ stage: 'resolve', text: '正在解析引擎下载链接...' });
    let engineSrc;
    try {
      engineSrc = await getResolved(engineCfg);
    } catch (e) {
      throw new Error('引擎包解析失败：' + e.message);
    }
    progressCb({ stage: 'engine', text: '正在下载 AI 引擎...' });
    const zipPath = path.join(tmpDir, AI_ENGINE_ZIP);
    await downloadNet(engineSrc.directUrl, zipPath, engineSrc.referer, (g, t) => {
      progressCb({ stage: 'engine', progress: t ? Math.round((g / t) * 100) : 0, text: '正在下载 AI 引擎 ' + Math.round(g / 1024 / 1024) + '/' + Math.round(t / 1024 / 1024) + ' MB' });
    });
    progressCb({ stage: 'engine-unzip', text: '正在安装 AI 引擎...' });
    await extractZip(zipPath, installDir);
    try { fs.unlinkSync(zipPath); } catch (e) {}

    // 2. 模型分卷顺序下载并拼接
    const modelPath = path.join(modelsDir, AI_MODEL_FILENAME);
    if (fs.existsSync(modelPath)) {
      try { fs.unlinkSync(modelPath); } catch (e) {}
    }
    const partCfgs = AI_DOWNLOAD_SOURCES.filter((x) => x.saveAs && x.saveAs.startsWith('qwen15b-gguf.part'));
    partCfgs.sort((a, b) => a.saveAs.localeCompare(b.saveAs));
    if (partCfgs.length === 0) throw new Error('未配置模型分卷下载源');
    const ws = fs.createWriteStream(modelPath);
    try {
      for (let i = 0; i < partCfgs.length; i++) {
        const partCfg = partCfgs[i];
        progressCb({ stage: 'resolve', part: i + 1, partCount: partCfgs.length, text: '正在解析模型分卷 ' + (i + 1) + '/' + partCfgs.length + ' ...' });
        let part;
        try {
          part = await getResolved(partCfg);
        } catch (e) {
          throw new Error('分卷 ' + (i + 1) + ' 解析失败：' + e.message);
        }
        const partZip = path.join(tmpDir, partCfg.saveAs);
        progressCb({ stage: 'model', part: i + 1, partCount: partCfgs.length, text: '正在下载模型分卷 ' + (i + 1) + '/' + partCfgs.length + ' ...' });
        await downloadChromium(part.directUrl, partZip, (g, t) => {
          if (progressCb) {
            const partPct = t ? g / t : 0;
            progressCb({ stage: 'model', part: i + 1, partCount: partCfgs.length, progress: Math.round(partPct * 100), text: '' });
          }
        });
        // 分卷是真正的 zip（蓝奏云只放行真压缩包），先解包出原始分块再追加
        const partDir = path.join(tmpDir, 'part' + String(i + 1).padStart(2, '0'));
        progressCb({ stage: 'model', part: i + 1, partCount: partCfgs.length, text: '正在解包模型分卷 ' + (i + 1) + '/' + partCfgs.length + ' ...' });
        await extractZip(partZip, partDir);
        const memberNames = fs.readdirSync(partDir).filter((f) => {
          try { return fs.statSync(path.join(partDir, f)).isFile(); } catch (e) { return false; }
        });
        if (memberNames.length === 0) throw new Error('模型分卷 ' + (i + 1) + ' 压缩包内容为空');
        const memberPath = path.join(partDir, memberNames[0]);
        const rs = fs.createReadStream(memberPath);
        await new Promise((resolve, reject) => {
          rs.on('data', (c) => { doneBytes += c.length; });
          rs.pipe(ws, { end: false });
          rs.on('end', resolve);
          rs.on('error', reject);
        });
        try { fs.unlinkSync(partZip); } catch (e) {}
        try { fs.rmSync(partDir, { recursive: true, force: true }); } catch (e) {}
        progressCb({ stage: 'model', part: i + 1, partCount: partCfgs.length, doneBytes, totalBytes, text: '' });
      }
      ws.end();
      await new Promise((resolve) => ws.on('finish', resolve));
    } catch (e) {
      try { ws.close(); } catch (_) {}
      throw e;
    }

    // 3. 校验
    const stat = fs.statSync(modelPath);
    if (stat.size !== totalBytes) {
      throw new Error('模型文件不完整（' + stat.size + '/' + totalBytes + '），请重新下载');
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    localLLM.state = 'idle'; // 复位，下次请求重新探测并启动
    progressCb({ stage: 'done', text: '内置 AI 安装完成！' });
    return true;
  } finally {
    closeLzWindow();
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#ffffff',
    title: 'C++ Playground',
    icon: path.join(__dirname, 'resources', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      webgl: false
    }
  });

  // 隐藏菜单栏
  mainWindow.setMenuBarVisibility(false);
  mainWindow.setMenu(null);

  // 注入CORS头，允许渲染进程调用外部API（如DeepSeek）
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders || {};
    headers['Access-Control-Allow-Origin'] = ['*'];
    callback({ responseHeaders: headers });
  });

  // 页面准备好再显示，避免白屏
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.loadFile(path.join(__dirname, 'resources', 'index.html'));
  
  // 窗口关闭时退出
  mainWindow.on('closed', () => {
    mainWindow = null;
    setTimeout(() => { app.exit(0); }, 100);
  });

  // 延迟注册 IPC（页面加载后再注册，不阻塞启动）
  setTimeout(registerIpc, 0);
}

// 延迟注册 IPC 处理器
// === 读取文本文件，自动检测编码（UTF-8 BOM / UTF-16 / UTF-8 / GBK），解决中文乱码 ===
function readTextFileAuto(filePath) {
  const fs = lazyFs();
  const buf = fs.readFileSync(filePath);
  if (!buf || buf.length === 0) return '';
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return buf.toString('utf8', 3); // UTF-8 BOM
  }
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    return buf.toString('utf16le', 2); // UTF-16 LE BOM
  }
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    return buf.swap16().toString('utf16le', 2); // UTF-16 BE BOM
  }
  // 兼容旧版 Node（Electron 31 内置 Node 20 无 Buffer.isUtf8）：用 fatal 模式严格校验 UTF-8
  let validUtf8 = true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    validUtf8 = false;
  }
  if (validUtf8) {
    return buf.toString('utf8');
  }
  // 非 UTF-8，按 GBK 解码（Windows 中文系统下常见的源码文件编码）
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch (e) {
    return buf.toString('utf8'); // 兜底，避免内容丢失
  }
}

function registerIpc() {
  const ipcMain = lazyIp();
  const fs = lazyFs();
  const os = lazyOs();
  const { spawn, execFileSync } = lazyCp();
  const dialog = lazyDialog();

  // 内置 AI 模型下载相关
  ipcMain.handle('ai-model-status', () => {
    return {
      installed: localLLM.available(),
      downloading: aiDownloadRunning,
      sourceCount: AI_DOWNLOAD_SOURCES.length,
      installDir: aiInstallDir(),
      modelSizeMB: Math.round(AI_DOWNLOAD_PLAN.modelTotalBytes / 1048576)
    };
  });

  ipcMain.handle('ai-model-download', async () => {
    if (aiDownloadRunning) return { ok: false, error: '下载已在进行中' };
    if (AI_DOWNLOAD_SOURCES.length === 0) {
      return { ok: false, error: '下载源尚未配置，请等待版本更新' };
    }
    aiDownloadRunning = true;
    try {
      aiProgress({ stage: 'start', text: '开始下载' });
      await runAiModelDownload((p) => aiProgress(p));
      aiDownloadRunning = false;
      return { ok: true };
    } catch (e) {
      aiDownloadRunning = false;
      aiProgress({ stage: 'error', text: e.message || String(e) });
      return { ok: false, error: e.message || String(e) };
    }
  });

  // 检测本地编译器（带缓存）
  function findCompiler(name) {
    const fs = lazyFs();
    // 先检查我们自己安装的目录
    if (name === 'g++') {
      const userGpp = path.join(app.getPath('userData'), 'mingw64', 'bin', 'g++.exe');
      if (fs.existsSync(userGpp)) return userGpp;
    }
    if (name === 'python') {
      const userPy = path.join(app.getPath('userData'), 'python', 'python.exe');
      if (fs.existsSync(userPy)) return userPy;
    }
    // 再检查系统 PATH
    try {
      const { execFileSync } = lazyCp();
      const result = execFileSync('where', [name], { encoding: 'utf8' }).trim();
      if (result) return result.split('\r\n')[0];
    } catch (e) {}
    return null;
  }

  function getCompilerInfo() {
    if (compilerCache) return compilerCache;
    const gpp = findCompiler('g++');
    const python = findCompiler('python') || findCompiler('python3');
    compilerCache = {
      hasGcc: !!gpp,
      gccPath: gpp,
      hasPython: !!python,
      pythonPath: python
    };
    return compilerCache;
  }

  ipcMain.handle('get-local-compiler', async () => {
    return getCompilerInfo();
  });

  // 保存文件
  ipcMain.handle('save-file', async (evt, { code, language }) => {
    const ext = (language === 'python') ? 'py' : 'cpp';
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: 'untitled.' + ext,
      filters: [
        { name: (ext === 'py') ? 'Python 文件' : 'C++ 文件', extensions: [ext] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (!result.canceled && result.filePath) {
      fs.writeFileSync(result.filePath, code || '', 'utf8');
      return result.filePath;
    }
    return null;
  });

  // 打开文件
  ipcMain.handle('open-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        { name: 'C++ 文件', extensions: ['cpp', 'cc', 'cxx'] },
        { name: 'Python 文件', extensions: ['py'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (!result.canceled && result.filePaths.length > 0) {
      const filePath = result.filePaths[0];
      const content = readTextFileAuto(filePath);
      return { ok: true, content, name: path.basename(filePath), filePath };
    }
    return { ok: false };
  });

  // 下载 g++ (MinGW) - 完整下载 + 解压 + 配置
  async function downloadGpp(silent = false) {
    const https = lazyHttps();
    const fs = lazyFs();
    const { execSync, spawn } = lazyCp();
    
    const installDir = path.join(app.getPath('userData'), 'mingw64');
    const downloadUrl = 'https://github.com/niXman/mingw-builds-binaries/releases/download/13.2.0-rt_v12-rev0/x86_64-13.2.0-release-posix-seh-msvcrt-rt_v12-rev0.7z';
    const archivePath = path.join(os.tmpdir(), 'mingw-download.7z');
    
    if (!silent && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download-progress', { percent: 0, status: '准备下载…' });
    }
    
    // 尝试多个镜像源
    const mirrors = [
      downloadUrl,
      'https://ghproxy.com/' + downloadUrl,
      'https://gh.api.99988866.xyz/' + downloadUrl
    ];
    
    async function tryDownload(urlIndex) {
      if (urlIndex >= mirrors.length) {
        return { ok: false, error: '所有下载源均失败，请检查网络' };
      }
      
      const url = mirrors[urlIndex];
      if (!silent && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-progress', { percent: 0, status: `正在下载…（源 ${urlIndex + 1}）` });
      }
      
      return new Promise((resolve) => {
        try {
          const file = fs.createWriteStream(archivePath);
          const doRequest = (u, redirectsLeft) => {
            const isHttps = u.startsWith('https');
            const client = isHttps ? https : require('http');
            client.get(u, (response) => {
              if ([301, 302, 303, 307, 308].includes(response.statusCode) && redirectsLeft > 0) {
                doRequest(response.headers.location, redirectsLeft - 1);
                return;
              }
              if (response.statusCode !== 200) {
                file.close();
                resolve(tryDownload(urlIndex + 1));
                return;
              }
              
              const total = parseInt(response.headers['content-length'] || '0');
              let downloaded = 0;
              
              response.on('data', (chunk) => {
                downloaded += chunk.length;
                if (total > 0 && !silent && mainWindow && !mainWindow.isDestroyed()) {
                  const percent = Math.round((downloaded / total) * 100);
                  mainWindow.webContents.send('download-progress', { 
                    percent, 
                    status: `下载中 ${percent}%` 
                  });
                }
              });
              
              response.pipe(file);
              
              file.on('finish', () => {
                file.close(async () => {
                  // 下载完成，开始解压
                  if (!silent && mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('download-progress', { percent: 95, status: '正在解压…' });
                  }
                  
                  try {
                    const extractDir = path.join(os.tmpdir(), 'mingw-extract');
                    if (fs.existsSync(extractDir)) {
                      fs.rmSync(extractDir, { recursive: true, force: true });
                    }
                    fs.mkdirSync(extractDir, { recursive: true });
                    
                    // 优先用系统自带 tar 解压（Windows 10 1903+ 自带 bsdtar，无需依赖 7-Zip）
                    let tarPath = null;
                    try {
                      const tarCheck = execSync('where tar', { encoding: 'utf8', timeout: 5000 }).trim();
                      if (tarCheck && tarCheck.includes('\\tar.exe')) tarPath = tarCheck.split('\r\n')[0];
                    } catch(e) {}
                    
                    if (tarPath) {
                      execSync(`"${tarPath}" -xf "${archivePath}" -C "${extractDir}"`, {
                        timeout: 120000
                      });
                    } else {
                      //  fallback 到 7z
                      const sevenZipPath = find7Zip();
                      if (sevenZipPath) {
                        execSync(`"${sevenZipPath}" x "${archivePath}" -o"${extractDir}" -y`, {
                          timeout: 120000
                        });
                      } else {
                        throw new Error('未找到解压工具，请安装 7-Zip 或更新 Windows 版本');
                      }
                    }
                    
                    // 找到 mingw64 目录
                    let mingwDir = path.join(extractDir, 'mingw64');
                    if (!fs.existsSync(mingwDir)) {
                      // 可能直接就是 bin 目录
                      const dirs = fs.readdirSync(extractDir);
                      if (dirs.length === 1) {
                        mingwDir = path.join(extractDir, dirs[0]);
                      }
                    }
                    
                    if (!fs.existsSync(path.join(mingwDir, 'bin', 'g++.exe'))) {
                      throw new Error('解压后未找到 g++.exe');
                    }
                    
                    // 移动到目标目录
                    if (fs.existsSync(installDir)) {
                      fs.rmSync(installDir, { recursive: true, force: true });
                    }
                    fs.mkdirSync(path.dirname(installDir), { recursive: true });
                    fs.renameSync(mingwDir, installDir);
                    
                    // 清理临时文件
                    try { fs.unlinkSync(archivePath); } catch(e) {}
                    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch(e) {}
                    
                    // 验证
                    const gppPath = path.join(installDir, 'bin', 'g++.exe');
                    if (!fs.existsSync(gppPath)) {
                      throw new Error('安装完成但未找到 g++.exe');
                    }
                    
                    // 清除编译器缓存
                    compilerCache = null;
                    
                    if (!silent && mainWindow && !mainWindow.isDestroyed()) {
                      mainWindow.webContents.send('download-progress', { percent: 100, status: '安装完成！' });
                    }
                    resolve({ ok: true, gccPath: gppPath });
                    
                  } catch (e) {
                    resolve({ ok: false, error: '解压失败: ' + e.message });
                  }
                });
              });
            }).on('error', (err) => {
              file.close();
              resolve(tryDownload(urlIndex + 1));
            });
          };
          doRequest(url, 5);
        } catch (e) {
          resolve({ ok: false, error: e.message });
        }
      });
    }
    
    return tryDownload(0);
  }

  ipcMain.handle('download-compiler', async () => {
    return downloadGpp(false);
  });

  // 安装版：启动时若没有本地 g++ 则自动下载（无需用户手动点击）。
  // 必须写在 registerIpc 内部——downloadGpp / find7Zip 都是该作用域的局部函数，
  // 放到外层作用域会静默失败（downloadGpp is not defined）。
  if (!isPortable) {
    setTimeout(async () => {
      try {
        const fs = lazyFs();
        const userGpp = path.join(app.getPath('userData'), 'mingw64', 'bin', 'g++.exe');
        if (fs.existsSync(userGpp)) return;
        // 系统 PATH 里已有 g++ 就不必再下载（避免重复拉取上百 MB）
        if (findCompiler('g++')) return;
        console.log('[installer mode] No g++ found, start auto-download...');
        await downloadGpp(false); // 显示下载进度弹窗
      } catch (e) {
        console.log('[installer mode] auto download g++ failed:', e.message);
      }
    }, 1500);
  }
  
  // 查找 7z 工具
  function find7Zip() {
    const candidates = [
      'C:\\Program Files\\7-Zip\\7z.exe',
      'C:\\Program Files (x86)\\7-Zip\\7z.exe',
      path.join(process.cwd(), '7z.exe')
    ];
    const fs = lazyFs();
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    // 尝试 where 查找
    try {
      const { execFileSync } = lazyCp();
      const result = execFileSync('where', ['7z'], { encoding: 'utf8' }).trim();
      if (result) return result.split('\r\n')[0];
    } catch(e) {}
    return null;
  }

  // 交互式运行
  // 保存模式记住的 CPP 路径（跨多次运行保留）
  let savedCppPath = '';

  ipcMain.handle('run-interactive', async (evt, { code, std, language, runMode }) => {
    const lang = language || 'cpp';
    const runId = ++currentRunId;
    
    // 终止之前的进程
    if (currentChild) {
      try { currentChild.kill('SIGTERM'); } catch(e){}
      currentChild = null;
    }
    
    // 运行模式：cache=临时目录(运行后自动清理)  save=用户指定路径(记住后覆盖)
    let tmpDir, srcPath;
    if (runMode === 'save') {
      if (!savedCppPath) {
        const r = await dialog.showSaveDialog(mainWindow, {
          title: '选择 CPP 文件保存位置',
          defaultPath: 'main.cpp',
          filters: [{ name: 'C++ Source', extensions: ['cpp'] }]
        });
        if (r.canceled || !r.filePath) {
          return { ok: false, error: '已取消保存', runId };
        }
        savedCppPath = r.filePath;
      }
      srcPath = savedCppPath;
      tmpDir = path.dirname(srcPath);
    } else {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpppg-'));
      srcPath = path.join(tmpDir, 'main.cpp');
    }
    let exePath = '';
    let args = [];
    let sourceLabel = '';
    let compileMs = 0;
    try {
      if (lang === 'cpp') {
        // 注入关闭 stdout/stderr 缓冲的代码，确保实时输出
        const unbufferCode = `#include <cstdio>
#include <iostream>
__attribute__((constructor)) static void _pg_unbuffer_io() {
    setvbuf(stdout, NULL, _IONBF, 0);
    setvbuf(stderr, NULL, _IONBF, 0);
    std::cout.setf(std::ios::unitbuf);
    std::cerr.setf(std::ios::unitbuf);
}
`;
        // 保存模式额外注入结束暂停，双击 EXE 时也能看到结果（应用内运行时会设置 _PG_NO_PAUSE 跳过）
        const pauseCode = (runMode === 'save')
          ? '\n#include <cstdlib>\n#include <cstdio>\n#include <conio.h>\nstatic void _pg_pause_on_exit() { if (!getenv("_PG_NO_PAUSE")) { printf("\\n请按任意键继续"); fflush(stdout); _getch(); } }\n__attribute__((constructor)) static void _pg_register_pause() { atexit(_pg_pause_on_exit); }\n'
          : '';
        fs.writeFileSync(srcPath, unbufferCode + pauseCode + code, 'utf8');
        exePath = (runMode === 'save') ? srcPath.replace(/\.cpp$/i, '.exe') : path.join(tmpDir, 'main.exe');
        
        const compiler = findCompiler('g++');
        if (!compiler) {
          // 没有本地编译器，返回 fallback 标记让前端使用在线 WASM 编译
          return { ok: false, error: 'no-local-compiler', runId, fallback: true };
        }
        sourceLabel = '本地 g++ (离线)';
        
        // 编译
        try {
          const compileStartTime = Date.now();
          const standard = std || 'c++11';
          execFileSync(compiler, [srcPath, '-o', exePath, '-std=' + standard, '-O2', '-Wall'], {
            cwd: tmpDir,
            timeout: 10000,
            encoding: 'utf8'
          });
          compileMs = Date.now() - compileStartTime;
        } catch (e) {
          return { ok: false, error: e.stderr || e.stdout || e.message, runId, compileError: true };
        }
      } else if (lang === 'python') {
        const pyPath = path.join(tmpDir, 'main.py');
        fs.writeFileSync(pyPath, code, 'utf8');
        
        const python = findCompiler('python') || findCompiler('python3');
        if (!python) {
          return { ok: false, error: 'no-local-compiler', runId, fallback: true };
        }
        exePath = python;
        args = ['-u', pyPath]; // -u 关闭缓冲，实时输出
        sourceLabel = '本地 Python (离线)';
      }
      
      const startTime = Date.now();

      // ===== 终端内运行模式（spawn + 管道，输出显示在应用内终端面板） =====
      if (runMode === 'terminal') {
        let child;
        try {
          child = spawn(exePath, args, {
            cwd: tmpDir,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            env: Object.assign({}, process.env, { _PG_NO_PAUSE: '1' })
          });
        } catch (e) {
          return { ok: false, error: '无法启动程序: ' + e.message, runId };
        }
        currentChild = child;
        const sendEvt = (e) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            e.runId = runId;
            mainWindow.webContents.send('run-event', e);
          }
        };
        child.stdout.on('data', (d) => sendEvt({ type: 'stdout', data: d.toString('utf8') }));
        child.stderr.on('data', (d) => sendEvt({ type: 'stderr', data: d.toString('utf8') }));
        // 超时 30 秒自动终止
        const timer = setTimeout(() => {
          try { child.kill('SIGTERM'); } catch(e){}
          sendEvt({ type: 'timeout' });
        }, 30000);
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          currentChild = null;
          sendEvt({ type: 'exit', code: code || 0, signal: signal, ms: Date.now() - startTime, compileMs: compileMs, source: sourceLabel });
          if (runMode !== 'save') { setTimeout(function() { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {} }, 5000); }
        });
        child.on('error', (e) => {
          clearTimeout(timer);
          currentChild = null;
          // 新编译的程序被安全软件/系统权限拦下时，Node 报的是 EACCES/EPERM。
          // 换成能看懂的中文提示，并直接给出要加白名单的文件路径。
          const em = String((e && e.message) || '');
          if ((e && (e.code === 'EACCES' || e.code === 'EPERM')) || /EACCES|EPERM|denied/i.test(em)) {
            sendEvt({ type: 'error', error: '无法启动程序：被安全软件或系统权限阻止了（Access is denied）。\n请把下面这个文件加入安全软件信任区（如 360、电脑管家），或临时退出安全软件后重试：\n' + exePath });
          } else {
            sendEvt({ type: 'error', error: em });
          }
        });
        return { ok: true, runId: runId, source: sourceLabel };
      }

      // 构造批处理脚本：运行程序后暂停，方便查看输出
      const flagFile = path.join(tmpDir, 'running.flag');
      const errFile = path.join(tmpDir, '_pg_stderr.txt');   // 程序 stderr 暂存文件
      const hint1File = path.join(tmpDir, '_pg_hint1.txt');  // 「自动重试」中文提示（用文件回放，避免批处理解析中文出错）
      const hint2File = path.join(tmpDir, '_pg_hint2.txt');  // 「被安全软件拦下」中文提示

      let batContent = '@echo off\r\nchcp 65001 >nul\r\ncd /d "' + tmpDir + '"\r\nset _PG_NO_PAUSE=1\r\necho. > "' + flagFile + '"\r\n';

      // 启动程序的命令行（cpp / python 各自不同）
      const launchLine = (lang === 'cpp')
        ? '"' + exePath + '"\r\n'
        : '"' + exePath + '" ' + args.map(function(a) { return '"' + a + '"'; }).join(' ') + '\r\n';

      // stderr 重定向到暂存文件，有两个好处：
      //  1) 当程序被安全软件/系统权限拦下时，是 cmd 自己往 stderr 打了一句英文
      //     "Access is denied."。重定向后这句话不再直接显示在窗口里，用户只会看到中文提示。
      //  2) 程序正常跑完后，再把 stderr 原样回放出来，不丢程序自己的报错信息。
      const launchQ = launchLine.replace('\r\n', ' 2>"' + errFile + '"\r\n');
      // 判定「启动被拦下」的充分条件：错误码 5 + stderr 里确实是系统的拒绝访问文案。
      // 只靠错误码会把「程序自己 return 5」误判成被拦截（那会导致程序被重复运行一次），
      // 所以必须同时匹配系统文案；匹配不到就完全按原来的方式走，不会有副作用。
      const denyProbe = 'findstr /i /c:"Access is denied" /c:"Access denied" /c:"拒绝访问" /c:"访问被拒绝" "' + errFile + '" >nul 2>nul\r\n'
        + 'if errorlevel 1 goto pg_done\r\n';

      batContent += 'set "TS=%TIME: =0%"\r\n';
      batContent += launchQ;
      batContent += 'set "EC=%errorlevel%"\r\n';
      batContent += 'if not "%EC%"=="5" goto pg_done\r\n';
      batContent += denyProbe;
      batContent += 'del "' + errFile + '" 2>nul\r\n';
      batContent += 'type "' + hint1File + '"\r\n';
      batContent += 'ping -n 2 127.0.0.1 >nul\r\n';
      batContent += launchQ;
      batContent += 'set "EC=%errorlevel%"\r\n';
      batContent += 'if not "%EC%"=="5" goto pg_done\r\n';
      batContent += denyProbe;
      batContent += 'del "' + errFile + '" 2>nul\r\n';
      batContent += 'type "' + hint2File + '"\r\n';
      batContent += ':pg_done\r\n';
      batContent += 'if exist "' + errFile + '" type "' + errFile + '"\r\n';
      batContent += 'del "' + errFile + '" 2>nul\r\n';
      batContent += 'set "T1=%TIME: =0%"\r\n';
      batContent += 'powershell -NoProfile -Command "$t0=[DateTime]::Parse(\'%TS%\'.Replace(\',\',\'.\'));$t1=[DateTime]::Parse(\'%T1%\'.Replace(\',\',\'.\'));if($t1 -lt $t0){$t1=$t1.AddDays(1)};($t1-$t0).TotalSeconds.ToString(\'g4\',[System.Globalization.CultureInfo]::InvariantCulture)" > rt.txt\r\n';
      batContent += 'set /p RT=<rt.txt\r\n';
      batContent += 'del rt.txt 2>nul\r\n';
      batContent += 'del "' + flagFile + '" 2>nul\r\n';
      batContent += 'echo --------------------------------\r\n';
      batContent += 'echo Process exited after %RT% seconds with return value %EC%\r\n';
      batContent += 'echo 请按任意键继续. . .\r\n';
      batContent += 'pause >nul';

      // 中文提示单独写成 UTF-8 文本，由批处理 type 回放。
      // 直接写在 echo 里时，某些全角标点会让 cmd 解析出错（把半句话当成命令）。
      const hint1Text = '[提示] 程序启动被安全软件或系统权限拦下了，1 秒后自动重试一次...\r\n';
      const hint2Text = '[提示] 程序仍然无法启动，被安全软件或系统权限阻止了。\r\n'
        + '[提示] 请把它加入安全软件信任区（如 360、电脑管家），或临时退出安全软件后重试：\r\n'
        + '       ' + exePath + '\r\n';
      fs.writeFileSync(hint1File, hint1Text, 'utf8');
      fs.writeFileSync(hint2File, hint2Text, 'utf8');

      const batPath = path.join(tmpDir, 'run.bat')
      fs.writeFileSync(batPath, batContent, 'utf8')

      // 使用 cmd 的 start 命令打开独立命令行窗口
      // 用 exec 而不是 spawn，避免参数引用问题
      const { exec } = lazyCp();
      try {
        exec('start "" cmd.exe /c "' + batPath + '"', {
          cwd: tmpDir,
          windowsHide: false
        });
      } catch (e) {
        return { ok: false, error: '无法启动命令行窗口: ' + e.message, runId };
      }
      currentChild = null; // 独立窗口不跟踪子进程

      // 立即通知前端：程序已在独立窗口中启动
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('run-event', {
          type: 'stdout',
          data: '// 已在独立命令行窗口中运行，请在弹出的窗口中查看输出和输入\n',
          runId: runId
        });
      }

      // 通过标志文件监控程序是否结束
      let monitorCount = 0;
      const maxMonitorMs = 300000;
      const checkInterval = 1000;

      function monitorProcess() {
        if (monitorCount * checkInterval > maxMonitorMs) {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('run-event', {
              type: 'stdout',
              data: '\n[提示] 程序运行时间较长，已在独立窗口中运行，可在窗口中查看完整输出。\n',
              runId: runId
            });
            mainWindow.webContents.send('run-event', {
              type: 'exit',
              code: 0,
              signal: null,
              ms: maxMonitorMs,
              compileMs: compileMs,
              runId: runId,
              source: sourceLabel
            });
          }
          return;
        }
        monitorCount++;

        if (fs.existsSync(flagFile)) {
          setTimeout(monitorProcess, checkInterval);
        } else {
          const ms = Date.now() - startTime;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('run-event', {
              type: 'exit',
              code: 0,
              signal: null,
              ms: ms,
              compileMs: compileMs,
              runId: runId,
              source: sourceLabel
            });
          }
          setTimeout(function() {
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
          }, 5000);
        }
      }

      setTimeout(monitorProcess, 2000);
      
      return { ok: true, runId: runId, source: sourceLabel }
      
    } catch (e) {
      return { ok: false, error: e.message, runId };
    }
  });

  // 发送 stdin
  ipcMain.handle('send-stdin', async (evt, data) => {
    if (currentChild && currentChild.stdin && !currentChild.stdin.destroyed) {
      try {
        currentChild.stdin.write(data);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    return { ok: false, error: '没有运行中的进程' };
  });

  // 终止进程
  ipcMain.handle('kill-process', async () => {
    if (currentChild) {
      try { currentChild.kill('SIGTERM'); } catch(e){}
      currentChild = null;
    }
    return { ok: true };
  });

  // ===================== 断点调试（gdb MI 接口）=====================
  let gdbProc = null;
  let gdbBuffer = '';
  let gdbCmdCounter = 0;
  let gdbPending = {};
  let gdbBpMap = {};   // 断点行号 -> gdb 内部断点编号（调试中删除断点用）

  function gdbSend(cmd) {
    return new Promise((resolve) => {
      const token = ++gdbCmdCounter;
      gdbPending[token] = resolve;
      gdbProc.stdin.write(token + cmd + '\n');
    });
  }

  function parseMiLine(line) {
    const result = { raw: line };
    if (line.startsWith('*stopped')) {
      result.type = 'stopped';
      const r = line.match(/reason="([^"]*)"/); result.reason = r ? r[1] : '';
      const f = line.match(/fullname="([^"]*)"/); result.file = f ? f[1] : '';
      const l = line.match(/line="(\d+)"/); result.line = l ? parseInt(l[1]) : 0;
      const fn = line.match(/func="([^"]*)"/); result.func = fn ? fn[1] : '';
    } else if (line.startsWith('*running')) {
      result.type = 'running';
    } else if (line.startsWith('~"')) {
      result.type = 'console';
      result.text = line.substring(2, line.length - 1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else if (line.startsWith('&"')) {
      result.type = 'log';
      result.text = line.substring(2, line.length - 1).replace(/\\n/g, '\n');
    } else if (line.startsWith('^done')) {
      result.type = 'done'; result.data = line;
    } else if (line.startsWith('^error')) {
      result.type = 'error';
      const m = line.match(/msg="([^"]*)"/); result.message = m ? m[1] : '';
    }
    return result;
  }

  // 还原 MI 字符串里的转义引号（\n 等保持原样，与 gdb print 输出一致）
  function miUnquote(s) {
    return s.replace(/\\(.)/g, (_, c) => (c === '"' || c === '\\') ? c : '\\' + c);
  }

  ipcMain.handle('debug-start', async (evt, { code, breakpoints, stdin }) => {
    if (gdbProc) { try { gdbProc.kill(); } catch(e){} gdbProc = null; }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cppdbg-'));
    const srcPath = path.join(tmpDir, 'main.cpp');
    fs.writeFileSync(srcPath, code, 'utf8');
    const exePath = path.join(tmpDir, 'main.exe');

    // 附加调试重定向编译单元（其全局构造函数在 main 之前执行），不改动用户代码、
    // 不影响断点行号映射：
    // 1) 程序 stdout/stderr 重定向到 out.txt，主进程轮询转发到前端——Windows 的
    //    gdb 7.8 不会把被调试程序输出经 MI 流转发，不重定向就看不到 cout 结果
    // 2) 预输入面板有内容时 stdin 重定向到 input.txt
    // 注意 freopen 必须用绝对路径（相对路径会相对 gdb 进程工作目录解析而打不开）
    const outPath = path.join(tmpDir, 'out.txt');
    const outEscaped = outPath.replace(/\\/g, '\\\\');
    const redirLines = [
      '#include <cstdio>',
      'namespace {',
      'struct DbgStdinRedirect {',
      '    DbgStdinRedirect() {',
      '        freopen("' + outEscaped + '", "w", stdout);',
      '        setvbuf(stdout, NULL, _IONBF, 0);',
      '        freopen("' + outEscaped + '", "a", stderr);'
    ];
    if (stdin !== undefined && stdin !== null && String(stdin).length > 0) {
      const inputPath = path.join(tmpDir, 'input.txt');
      fs.writeFileSync(inputPath, String(stdin), 'utf8');
      redirLines.push('        freopen("' + inputPath.replace(/\\/g, '\\\\') + '", "r", stdin);');
    }
    redirLines.push('    }', '};', 'DbgStdinRedirect __dbg_stdin_redirect_instance;', '}', '');
    const redirPath = path.join(tmpDir, 'dbgredirect.cpp');
    fs.writeFileSync(redirPath, redirLines.join('\r\n'), 'utf8');
    const compileArgs = ['-g', '-O0', '-std=c++11', '-o', exePath, srcPath, redirPath];

    const compiler = findCompiler('g++');
    if (!compiler) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e){}
      return { ok: false, error: 'no-compiler' };
    }

    const compileRes = await new Promise((resolve) => {
      const c = spawn(compiler, compileArgs);
      let err = '';
      c.stderr.on('data', d => err += d.toString());
      c.on('close', code => resolve({ code, err }));
    });
    if (compileRes.code !== 0) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e){}
      return { ok: false, error: 'compile-failed', details: compileRes.err };
    }

    const gdbPath = findCompiler('gdb');
    if (!gdbPath) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e){}
      return { ok: false, error: 'no-gdb' };
    }

    const thisProc = gdbProc = spawn(gdbPath, ['--interpreter=mi2', '--quiet', exePath]);
    gdbBuffer = ''; gdbCmdCounter = 0; gdbPending = {}; gdbBpMap = {};

    // 轮询 out.txt，把程序输出增量转发到前端
    let outOffset = 0;
    const outPoll = setInterval(() => {
      try {
        const st = fs.statSync(outPath);
        if (st.size > outOffset) {
          const fd = fs.openSync(outPath, 'r');
          const b = Buffer.alloc(st.size - outOffset);
          fs.readSync(fd, b, 0, b.length, outOffset);
          fs.closeSync(fd);
          outOffset = st.size;
          mainWindow.webContents.send('debug-event', { type: 'output', text: b.toString('utf8') });
        }
      } catch(e) {}
    }, 200);

    gdbProc.stdout.on('data', (data) => {
      gdbBuffer += data.toString();
      const miLines = gdbBuffer.split('\n');
      gdbBuffer = miLines.pop();
      for (const line of miLines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const tokenMatch = trimmed.match(/^(\d+)(\^.*)/);
        if (tokenMatch) {
          const token = parseInt(tokenMatch[1]);
          if (gdbPending[token]) { gdbPending[token](parseMiLine(tokenMatch[2])); delete gdbPending[token]; }
          continue;
        }
        const parsed = parseMiLine(trimmed);
        if (parsed.type === 'stopped') {
          // --all-values：完整读出变量值（数组/vector 能看到内容；--simple-values 只给 [...]）
          gdbSend('-stack-list-locals --all-values').then((res) => {
            const locals = [];
            if (res.data) {
              const re = /name="((?:[^"\\]|\\.)*)"(?:,type="((?:[^"\\]|\\.)*)")?,value="((?:[^"\\]|\\.)*)"/g;
              let m;
              while ((m = re.exec(res.data)) !== null) {
                locals.push({ name: miUnquote(m[1]), type: miUnquote(m[2] || ''), value: miUnquote(m[3]) });
              }
            }
            mainWindow.webContents.send('debug-event', {
              type: 'stopped', reason: parsed.reason,
              file: parsed.file, line: parsed.line, func: parsed.func, locals
            });
          });
        } else if (parsed.type === 'console' || parsed.type === 'log') {
          mainWindow.webContents.send('debug-event', { type: 'output', text: parsed.text });
        }
      }
    });

    gdbProc.stderr.on('data', (data) => {
      mainWindow.webContents.send('debug-event', { type: 'output', text: data.toString() });
    });

    thisProc.on('close', () => {
      try { clearInterval(outPoll); } catch(e){}
      // 收尾前把剩余输出读完
      try {
        const st = fs.statSync(outPath);
        if (st.size > outOffset) {
          const fd = fs.openSync(outPath, 'r');
          const b = Buffer.alloc(st.size - outOffset);
          fs.readSync(fd, b, 0, b.length, outOffset);
          fs.closeSync(fd);
          mainWindow.webContents.send('debug-event', { type: 'output', text: b.toString('utf8') });
        }
      } catch(e) {}
      mainWindow.webContents.send('debug-event', { type: 'exited' });
      if (gdbProc === thisProc) gdbProc = null;
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e){}
    });

    await new Promise(r => setTimeout(r, 600));
    for (const bp of (breakpoints || [])) {
      const res = await gdbSend('-break-insert main.cpp:' + bp);
      const nm = res.data && res.data.match(/number="(\d+)"/);
      if (nm) gdbBpMap[bp] = parseInt(nm[1]);
    }
    await gdbSend('-exec-run');
    return { ok: true };
  });

  ipcMain.handle('debug-command', async (evt, cmd, arg) => {
    if (!gdbProc) return { ok: false, error: 'no-session' };
    const miCmds = { continue: '-exec-continue', next: '-exec-next', step: '-exec-step', finish: '-exec-finish' };
    if (miCmds[cmd]) { await gdbSend(miCmds[cmd]); return { ok: true }; }
    // 调试中增删断点：同步给 gdb 并维护 行号->断点编号 映射
    if (cmd === 'addBreakpoint') {
      const res = await gdbSend('-break-insert main.cpp:' + arg);
      if (res.type === 'error') return { ok: false, error: res.message || '插入断点失败' };
      const nm = res.data && res.data.match(/number="(\d+)"/);
      if (nm) gdbBpMap[arg] = parseInt(nm[1]);
      return { ok: true };
    }
    if (cmd === 'removeBreakpoint') {
      const num = gdbBpMap[arg];
      if (num !== undefined) {
        const res = await gdbSend('-break-delete ' + num);
        delete gdbBpMap[arg];
        if (res.type === 'error') return { ok: false, error: res.message || '删除断点失败' };
      }
      return { ok: true };
    }
    return { ok: false, error: 'unknown-command' };
  });

  ipcMain.handle('debug-stop', async () => {
    if (gdbProc) {
      try {
        gdbProc.stdin.write('-gdb-exit\n');
        setTimeout(() => { if (gdbProc) { try { gdbProc.kill(); } catch(e){} gdbProc = null; } }, 600);
      } catch(e) { try { gdbProc.kill(); } catch(e2){} gdbProc = null; }
    }
    return { ok: true };
  });

  // AI 聊天（主进程调用，绕过CORS）
  ipcMain.handle('ai-chat', async (evt, { systemPrompt, userPrompt, images, useLocal, zpKey, zpModel, gqKey, sfKey, dsKey, dsModel, dbKey, dbModel, history }) => {
    // 确保模型参数有默认值
    if (!zpModel) zpModel = 'auto';
    if (!dsModel) dsModel = 'auto';
    if (!dbModel) dbModel = 'auto';
    const https = lazyHttps();

    // 多轮历史拼接：渲染层传入当前会话过往问答（[{role:'user'|'assistant', content}...]）时拼入，
    // 单条超长兜底截断；未传 history 时保持原单轮行为
    const buildMsgList = (userContent) => {
      const msgs = [{ role: 'system', content: systemPrompt }];
      if (Array.isArray(history)) {
        for (const h of history) {
          if (!h) continue;
          const role = h.role === 'assistant' ? 'assistant' : 'user';
          const txt = typeof h.content === 'string' ? h.content.trim() : '';
          if (!txt) continue;
          msgs.push({ role: role, content: txt.length > 2500 ? txt.slice(0, 2500) + '…' : txt });
        }
      }
      msgs.push({ role: 'user', content: userContent });
      return msgs;
    };

    function httpRequest(url, method, headers, body, timeoutMs) {
      return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const isHttps = parsed.protocol === 'https:';
        const lib = isHttps ? https : require('http');
        const finalHeaders = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) C++Playground/' + APP_VERSION,
          ...headers
        };
        const options = {
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: method,
          headers: finalHeaders,
          agent: isHttps ? lazyHttpsAgent() : lazyHttpAgent()
        };
        if (body) finalHeaders['Content-Length'] = Buffer.byteLength(body);
        const req = lib.request(options, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return resolve(httpRequest(res.headers.location, method, headers, body, timeoutMs));
          }
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => data += chunk);
          res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs || 30000, () => { req.destroy(); reject(new Error('请求超时')); });
        // 连接建立超时：网络卡顿时快速失败，便于降级到下一个提供商
        const connectTimer = setTimeout(() => { req.destroy(new Error('连接超时')); }, 15000);
        req.on('socket', (socket) => {
          if (socket.connecting) {
            socket.once('connect', () => clearTimeout(connectTimer));
          } else {
            clearTimeout(connectTimer);
          }
        });
        if (body) req.write(body);
        req.end();
      });
    }

    const errors = [];

    // 内置本地大模型优先（离线免费，无需 API Key）
    const hasImgForLocal = images && images.length > 0;
    if (useLocal && !hasImgForLocal) {
      try {
        const started = await localLLM.ensureStarted();
        if (started) {
          const body = JSON.stringify({
            model: 'local',
            messages: buildMsgList(userPrompt)
          });
          const localRes = await httpRequest('http://127.0.0.1:' + LOCAL_LLM_PORT + '/v1/chat/completions', 'POST', {
            'Content-Type': 'application/json'
          }, body, 300000);
          if (localRes.status === 200) {
            const data = JSON.parse(localRes.body);
            const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
            if (text) return { ok: true, text: text, provider: '内置AI·离线免费（Qwen2.5-Coder-1.5B）' };
          } else {
            errors.push('内置AI: HTTP ' + localRes.status);
          }
        } else {
          errors.push('内置AI: ' + localLLM.startError);
        }
      } catch (e) {
        errors.push('内置AI: ' + e.message);
      }
    }

    // 0. DeepSeek（V4 系列，写代码最强，付费但便宜，优先使用）
    if (dsKey) {
      const hasImage = images && images.length > 0;
      let dsModels;
      if (dsModel && dsModel !== 'auto') {
        dsModels = [dsModel];
      } else {
        dsModels = hasImage
          ? ['deepseek-v4-flash-vision-exp']
          : ['deepseek-v4-pro', 'deepseek-v4-flash'];
      }
      const timeout = hasImage ? 90000 : 60000;
      for (const model of dsModels) {
        try {
          let userContent;
          if (hasImage) {
            userContent = [];
            for (const img of images) {
              userContent.push({ type: 'image_url', image_url: { url: img } });
            }
            userContent.push({ type: 'text', text: userPrompt });
          } else {
            userContent = userPrompt;
          }
          const body = JSON.stringify({
            model: model,
            messages: buildMsgList(userContent)
          });
          const result = await httpRequest('https://api.deepseek.com/v1/chat/completions', 'POST', {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + dsKey
          }, body, timeout);
          if (result.status === 200) {
            const data = JSON.parse(result.body);
            const text = data?.choices?.[0]?.message?.content;
            if (text) return { ok: true, text: text, provider: 'DeepSeek/' + model };
          } else if (result.status === 401) {
            break;
          }
        } catch (e) {
          errors.push('DeepSeek: ' + e.message);
        }
      }
    }

    // 0.5 智谱 GLM-4.7 系列（永久免费，国内可用）
    if (dbKey) {
      const hasImage = images && images.length > 0;
      let dbModels;
      if (dbModel && dbModel !== 'auto') {
        dbModels = [dbModel];
      } else {
        dbModels = hasImage ? ['glm-4.6v-flash'] : ['glm-4.7-flash', 'glm-4.6v-flash', 'glm-4.5-flash'];
      }
      const timeout = hasImage ? 90000 : 45000;
      for (const model of dbModels) {
        try {
          let userContent;
          if (hasImage) {
            userContent = [];
            for (const img of images) {
              userContent.push({ type: 'image_url', image_url: { url: img } });
            }
            userContent.push({ type: 'text', text: userPrompt });
          } else {
            userContent = userPrompt;
          }
          const body = JSON.stringify({
            model: model,
            messages: buildMsgList(userContent)
          });
          const result = await httpRequest('https://open.bigmodel.cn/api/paas/v4/chat/completions', 'POST', {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + dbKey
          }, body, timeout);
          if (result.status === 200) {
            const data = JSON.parse(result.body);
            const text = data?.choices?.[0]?.message?.content;
            if (text) return { ok: true, text: text, provider: '智谱GLM-4.7/' + model };
          } else if (result.status === 401) {
            break;
          }
        } catch (e) {
          errors.push('智谱GLM-4.7: ' + e.message);
        }
      }
    }

    // 1. 智谱AI（国内可用，免费模型）
    if (zpKey) {
      const hasImage = images && images.length > 0;
      let zpModels;
      if (zpModel && zpModel !== 'auto') {
        // 用户手动选择了模型，只使用该模型
        zpModels = [zpModel];
      } else {
        // 自动选择：按优先级降级（均为永久免费且会输出思考过程的模型）
        zpModels = hasImage
          ? ['glm-4.6v-flash', 'glm-4.1v-thinking-flash']
          : ['glm-4.7-flash', 'glm-4.6v-flash', 'glm-4.5-flash'];
      }
      const timeout = hasImage ? 90000 : 45000;
      for (const model of zpModels) {
        try {
          let userContent;
          if (hasImage) {
            userContent = [];
            for (const img of images) {
              userContent.push({ type: 'image_url', image_url: { url: img } });
            }
            userContent.push({ type: 'text', text: userPrompt });
          } else {
            userContent = userPrompt;
          }
          const messages = buildMsgList(userContent);
          const body = JSON.stringify({ model: model, messages: messages });
          const result = await httpRequest('https://open.bigmodel.cn/api/paas/v4/chat/completions', 'POST', {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + zpKey
          }, body, timeout);
          if (result.status === 200) {
            const data = JSON.parse(result.body);
            const text = data?.choices?.[0]?.message?.content;
            if (text) return { ok: true, text: text, provider: '智谱AI/' + model };
          } else {
            errors.push('智谱AI ' + model + ': HTTP ' + result.status + ' ' + result.body.substring(0, 100));
            if (result.status === 401) break;
          }
        } catch (e) {
          errors.push('智谱AI: ' + e.message);
        }
      }
    }

    // 2. SiliconFlow（国内可用，免费模型）
    if (sfKey) {
      const sfModels = [
        'THUDM/GLM-4-9B-0414',
        'THUDM/GLM-Z1-9B-0414',
        'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',
        'deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B'
      ];
      let sfTried = 0;
      for (const model of sfModels) {
        try {
          const body = JSON.stringify({
            model: model,
            messages: buildMsgList(userPrompt)
          });
          const result = await httpRequest('https://api.siliconflow.cn/v1/chat/completions', 'POST', {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + sfKey
          }, body);
          if (result.status === 200) {
            const data = JSON.parse(result.body);
            const text = data?.choices?.[0]?.message?.content;
            if (text) return { ok: true, text: text, provider: 'SiliconFlow/' + model };
          } else {
            sfTried++;
            if (sfTried === 1) {
              errors.push('SiliconFlow ' + model.split('/').pop() + ': HTTP ' + result.status + ' ' + result.body.substring(0, 120));
            }
            if (result.status === 401 || result.body.indexOf('invalid') >= 0) break;
          }
        } catch (e) {
          sfTried++;
          if (sfTried === 1) errors.push('SiliconFlow: ' + e.message);
        }
      }
    }

    // 2. Groq（国外服务，需代理，速度快）
    if (gqKey) {
      const gqModels = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'gemma2-9b-it'];
      for (const model of gqModels) {
        try {
          const body = JSON.stringify({
            model: model,
            messages: buildMsgList(userPrompt)
          });
          const result = await httpRequest('https://api.groq.com/openai/v1/chat/completions', 'POST', {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + gqKey
          }, body);
          if (result.status === 200) {
            const data = JSON.parse(result.body);
            const text = data?.choices?.[0]?.message?.content;
            if (text) return { ok: true, text: text, provider: 'Groq/' + model };
          }
        } catch (e) {}
      }
    }

    const errDetail = errors.length > 0 ? errors.join('; ') : '所有模型均调用失败';
    return { ok: false, error: 'AI调用失败: ' + errDetail + '。可尝试开启内置AI或填入 API 密钥' };
  });

  // AI 流式聊天（主进程调用，边生成边推送到渲染进程）
  ipcMain.on('ai-chat-stream', async (event, { systemPrompt, userPrompt, images, useLocal, zpKey, zpModel, gqKey, sfKey, dsKey, dsModel, dbKey, dbModel, history }) => {
    if (!zpModel) zpModel = 'auto';
    if (!dsModel) dsModel = 'auto';
    if (!dbModel) dbModel = 'auto';

    const send = (payload) => {
      try {
        if (event.sender && !event.sender.isDestroyed()) {
          event.sender.send('ai-chat-stream-event', payload);
        }
      } catch (e) {}
    };

    // 流式请求单个模型。
    // tryClaim() 由「对冲调度器」提供：第一个吐出内容的候选拿到 true（赢得比赛），
    // 其余候选拿到 false 就必须立刻自我中断——否则两条流会把回答搅在一起。
    // holder.abort 让调度器在别人赢了之后从外部掐断这条连接。
    function streamOne(url, headers, body, timeoutMs, providerLabel, tryClaim, holder) {
      return new Promise((resolve) => {
        const https = lazyHttps();
        const parsed = new URL(url);
        const isHttps = parsed.protocol === 'https:';
        const lib = isHttps ? https : lazyHttp();
        const finalHeaders = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) C++Playground/' + APP_VERSION,
          'Accept': 'text/event-stream',
          ...headers
        };
        const options = {
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: 'POST',
          headers: finalHeaders,
          agent: isHttps ? lazyHttpsAgent() : lazyHttpAgent()
        };
        if (body) finalHeaders['Content-Length'] = Buffer.byteLength(body);

        let started = false;
        let claimed = false;
        let settled = false;
        let req = null;
        let connectTimer = null;
        let firstTimer = null;
        const finish = (r) => {
          if (settled) return;
          settled = true;
          if (connectTimer) clearTimeout(connectTimer);
          if (firstTimer) clearTimeout(firstTimer);
          try { if (req) req.destroy(); } catch (e) {}
          resolve(r);
        };
        if (holder) holder.abort = () => finish({ ok: false, started: false, aborted: true });

        // 只有赢得比赛的候选才有资格把字推给界面
        const pushDelta = (kind, text) => {
          if (!claimed) {
            if (!tryClaim(providerLabel)) { finish({ ok: false, started: false, aborted: true }); return; }
            claimed = true;
          }
          send({ type: 'delta', text: text, provider: providerLabel, kind: kind });
        };

        req = lib.request(options, (res) => {
          if (res.statusCode !== 200) {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (c) => data += c);
            res.on('end', () => finish({ ok: false, started: false, error: 'HTTP ' + res.statusCode + describeHttpBody(data) }));
            return;
          }
          let buffer = '';
          firstTimer = setTimeout(() => {
            if (!started) { finish({ ok: false, started: false, error: '响应超时' }); }
          }, 20000);
          res.on('data', (chunk) => {
            started = true;
            clearTimeout(firstTimer);
            buffer += chunk.toString('utf8');
            let idx;
            while ((idx = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, idx).replace(/\r$/, '');
              buffer = buffer.slice(idx + 1);
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith('data:')) continue;
              const payload = trimmed.slice(5).trim();
              if (payload === '[DONE]') continue;
              try {
                const json = JSON.parse(payload);
                const ch = json && json.choices && json.choices[0] && json.choices[0].delta;
                const contentText = (ch && ch.content) || '';
                const reasoningText = (ch && ch.reasoning_content) || '';
                if (contentText) pushDelta('content', contentText);
                else if (reasoningText) pushDelta('reasoning', reasoningText);
              } catch (e) {}
            }
          });
          res.on('end', () => finish(claimed
            ? { ok: true, started: true, won: true }
            : { ok: false, started: started, error: started ? '响应中断' : '' }));
          res.on('error', (e) => finish(claimed
            ? { ok: false, started: true, error: e.message }
            : { ok: false, started: started, error: e.message }));
        });

        req.on('error', (e) => finish(claimed
          ? { ok: false, started: true, error: e.message }
          : { ok: false, started: false, error: e.message }));
        req.setTimeout(timeoutMs || 60000, () => { finish(claimed
          ? { ok: false, started: true, error: '请求超时' }
          : { ok: false, started: false, error: '请求超时' }); });
        connectTimer = setTimeout(() => { finish({ ok: false, started: false, error: '连接超时' }); }, 15000);
        req.on('socket', (socket) => {
          if (socket.connecting) socket.once('connect', () => clearTimeout(connectTimer));
          else clearTimeout(connectTimer);
        });
        if (body) req.write(body);
        req.end();
      });
    }

    const hasImage = images && images.length > 0;

    // 构建按优先级排列的提供商/模型列表
    const providers = [];

    if (dsKey) {
      const dsModels = (dsModel && dsModel !== 'auto') ? [dsModel] : (hasImage ? ['deepseek-v4-flash-vision-exp'] : ['deepseek-v4-pro', 'deepseek-v4-flash']);
      for (const model of dsModels) {
        providers.push({ label: 'DeepSeek/' + model, url: 'https://api.deepseek.com/v1/chat/completions', key: dsKey, model: model, timeout: hasImage ? 90000 : 60000, withImage: hasImage });
      }
    }
    if (dbKey) {
      const dbModels = (dbModel && dbModel !== 'auto') ? [dbModel] : (hasImage ? ['glm-4.6v-flash'] : ['glm-4.7-flash', 'glm-4.6v-flash', 'glm-4.5-flash']);
      for (const model of dbModels) {
        providers.push({ label: '智谱GLM-4.7/' + model, url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', key: dbKey, model: model, timeout: hasImage ? 90000 : 45000, withImage: hasImage });
      }
    }
    if (zpKey) {
      const zpModels = (zpModel && zpModel !== 'auto') ? [zpModel] : (hasImage ? ['glm-4.6v-flash', 'glm-4.1v-thinking-flash'] : ['glm-4.7-flash', 'glm-4.6v-flash', 'glm-4.5-flash']);
      for (const model of zpModels) {
        providers.push({ label: '智谱AI/' + model, url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', key: zpKey, model: model, timeout: hasImage ? 90000 : 45000, withImage: hasImage });
      }
    }
    if (sfKey) {
      const sfModels = ['THUDM/GLM-4-9B-0414', 'THUDM/GLM-Z1-9B-0414', 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B', 'deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B'];
      for (const model of sfModels) {
        providers.push({ label: 'SiliconFlow/' + model.split('/').pop(), url: 'https://api.siliconflow.cn/v1/chat/completions', key: sfKey, model: model, timeout: 60000, withImage: false });
      }
    }
    if (gqKey) {
      const gqModels = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'gemma2-9b-it'];
      for (const model of gqModels) {
        providers.push({ label: 'Groq/' + model, url: 'https://api.groq.com/openai/v1/chat/completions', key: gqKey, model: model, timeout: 60000, withImage: false });
      }
    }

    // 内置智谱 GLM-4.7 兜底（用户没有填自己的智谱 Key 时才启用，作者 API，永久免费）
    // 注意判断条件：zpKey 是用户自填的智谱 Key，dbKey 是历史遗留的同一含义字段，
    // 两者都为空才用内置 Key，否则会重复占用一次内置额度。
    if (!zpKey && !dbKey && EMBED_ZHIPU && EMBED_ZHIPU.key) {
      for (const model of EMBED_ZHIPU.models) {
        providers.push({ label: '智谱GLM-4.7·内置/' + model, url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', key: EMBED_ZHIPU.key, model: model, timeout: hasImage ? 90000 : 45000, withImage: hasImage });
      }
    }

    // 上次成功的模型排到最前面（只调整云端候选的顺序，本地离线模型仍保持最高优先级）
    const prefModel = loadAiPrefModel();
    if (prefModel && !hasImage) {
      providers.sort((x, y) => (y.model === prefModel ? 1 : 0) - (x.model === prefModel ? 1 : 0));
    }

    // 内置本地大模型优先（离线免费，无需 API Key；图片提问走云端多模态）
    if (useLocal && !hasImage) {
      const started = await localLLM.ensureStarted();
      if (started) {
        providers.unshift({
          label: '内置AI·离线免费（Qwen2.5-Coder-1.5B）',
          url: 'http://127.0.0.1:' + LOCAL_LLM_PORT + '/v1/chat/completions',
          key: '',
          model: 'local',
          timeout: 300000,
          withImage: false,
          local: true
        });
      }
    }

    if (providers.length === 0) {
      if (useLocal && !localLLM.available()) {
        send({ type: 'done', ok: false, error: '内置 AI 模型尚未下载，请打开 设置 → 内置AI 点击「下载内置AI模型」（约 1.1GB，仅需一次）' });
      } else {
        send({ type: 'done', ok: false, error: useLocal ? ('内置AI启动失败：' + (localLLM.startError || '未知原因') + '。可在设置中填入 API 密钥改用联网AI') : '请在设置中填入 API 密钥' });
      }
      return;
    }

    const errors = [];
    // 内置 API 额度是否耗尽 / 用户是否自带密钥：用于给出更准确的失败提示
    let embedQuota = false;
    const hasOwnKeys = !!(dsKey || dbKey || zpKey || sfKey || gqKey);

    // === 多模型对冲（hedging）===
    // 以前是「一个模型跑完失败才轮到下一个」：glm-4.7-flash 经常被限流，甚至被排队几十秒才回包头，
    // 用户就得干等它彻底失败，本来能用的 4.6v-flash 才轮得上场——这就是「首次连接特别慢」的主因。
    // 现在第一个候选先上，HEDGE_STEP 毫秒内还没出字就并行放出下一个（最多 3 个同时在飞），
    // 谁先吐字谁赢、其余立刻掐断；被限流（429）这类快速失败会直接让下一个提前上场，不再白等阶梯计时。
    const HEDGE_STEP = 1200;
    const MAX_IN_FLIGHT = 3;

    function buildBody(p) {
      let userContent;
      if (p.withImage && hasImage) {
        userContent = [];
        for (const img of images) userContent.push({ type: 'image_url', image_url: { url: img } });
        userContent.push({ type: 'text', text: userPrompt });
      } else {
        userContent = userPrompt;
      }
      // 多轮历史：渲染层把当前会话的过往问答带上来（已在渲染层裁剪），
      // 图片只在当次请求有效，历史一律按纯文本传递；单条超长兜底截断，
      // 避免把旧代码原文整段带上导致 token 爆炸。
      const msgs = [{ role: 'system', content: systemPrompt }];
      if (Array.isArray(history)) {
        for (const h of history) {
          if (!h) continue;
          const role = h.role === 'assistant' ? 'assistant' : 'user';
          const txt = typeof h.content === 'string' ? h.content.trim() : '';
          if (!txt) continue;
          msgs.push({ role: role, content: txt.length > 2500 ? txt.slice(0, 2500) + '…' : txt });
        }
      }
      msgs.push({ role: 'user', content: userContent });
      return JSON.stringify({
        model: p.model,
        stream: true,
        messages: msgs
      });
    }

    let cursor = 0;                 // 下一个还没上场的候选
    let inFlight = 0;
    let winnerLabel = '';
    let reported = false;
    let ladderTimer = null;
    const activeHolders = [];

    function stopLadder() { if (ladderTimer) { clearInterval(ladderTimer); ladderTimer = null; } }
    function report(payload) {
      if (reported) return;
      reported = true;
      stopLadder();
      send(payload);
    }

    function tryClaim(label) {
      if (winnerLabel) return false;
      winnerLabel = label;
      stopLadder();
      // 赢了：把还在等的候选全部掐断，别让它们继续占着额度
      for (const h of activeHolders) {
        if (h.label !== label && h.abort) { try { h.abort(); } catch (e) {} }
      }
      return true;
    }

    function startProvider(p) {
      inFlight++;
      const holder = { label: p.label, abort: null };
      activeHolders.push(holder);
      const headers = p.local
        ? { 'Content-Type': 'application/json' }
        : { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + p.key };
      streamOne(p.url, headers, buildBody(p), p.timeout, p.label, tryClaim, holder).then((r) => {
        inFlight--;
        if (r.won) {
          saveAiPrefModel(p.model);
          report({ type: 'done', ok: true, provider: p.label });
          return;
        }
        if (winnerLabel === p.label) {
          // 赢家中途断了：如实告诉用户，不悄悄换人接着写（两条流拼起来会前后矛盾）
          report({ type: 'done', ok: false, provider: p.label, error: r.error || '输出中断' });
          return;
        }
        if (r.aborted) return;
        if (r.error) {
          errors.push(p.label + ': ' + r.error);
          if (!embedQuota && p.key === EMBED_ZHIPU.key && isQuotaError(r.error)) embedQuota = true;
        }
        pump();   // 有人退场就立刻补位，不等阶梯计时
      });
    }

    function pump() {
      if (winnerLabel || reported) { stopLadder(); return; }
      if (cursor < providers.length && inFlight < MAX_IN_FLIGHT) {
        startProvider(providers[cursor++]);   // 一次只放一个，节奏交给阶梯计时器
      } else if (cursor >= providers.length && inFlight === 0) {
        const joinedErr = errors.length ? errors.join('; ') : '所有模型均调用失败';
        let finalMsg = joinedErr + '。请检查网络或密钥';
        if (embedQuota && !hasOwnKeys) {
          finalMsg = '内置 AI 的免费额度已用完（' + joinedErr + '）。请到 设置 → AI 助手 填入你自己的 API 密钥，或到 设置 → 内置AI 点击「下载内置AI模型」（约 1.1GB，免费不限次数）。';
        }
        report({ type: 'done', ok: false, error: finalMsg });
      }
    }

    pump();                                       // 第一个候选立刻上场
    ladderTimer = setInterval(pump, HEDGE_STEP);  // 每 1.2 秒再放一个候选上场
  });

  // 洛谷：获取题目详情
  ipcMain.handle('luogu-get-problem', async (evt, problemId) => {
    try {
      const url = `https://www.luogu.com.cn/problem/${encodeURIComponent(problemId)}`;
      const resp = await net.fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
        }
      });
      if (!resp.ok) {
        return { ok: false, error: `请求失败：HTTP ${resp.status}` };
      }
      const html = await resp.text();
      
      // 解析题目信息
      const result = parseLuoguProblem(html, problemId);
      if (!result.title) {
        return { ok: false, error: '未找到该题目，请检查题号是否正确' };
      }
      return { ok: true, data: result };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 洛谷：在浏览器中打开提交页面
  ipcMain.handle('luogu-open-submit', async (evt, problemId) => {
    const { shell } = require('electron');
    const url = `https://www.luogu.com.cn/problem/${encodeURIComponent(problemId)}#submit`;
    shell.openExternal(url);
    return { ok: true };
  });

  // 选择并安装 MinGW（用户选择 mingw64 文件夹）
  ipcMain.handle('install-mingw', async () => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 mingw64 文件夹',
      properties: ['openDirectory'],
      buttonLabel: '安装到此文件夹'
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, error: '已取消' };
    }
    const selectedDir = result.filePaths[0];
    const fs = lazyFs();
    const installDir = path.join(app.getPath('userData'), 'mingw64');
    
    // 验证选择的目录是否包含 bin\g++.exe
    const gppInSelected = path.join(selectedDir, 'bin', 'g++.exe');
    if (!fs.existsSync(gppInSelected)) {
      // 可能选择的是父目录，再找一下
      const subDirs = fs.readdirSync(selectedDir);
      let found = false;
      for (const d of subDirs) {
        const candidate = path.join(selectedDir, d, 'bin', 'g++.exe');
        if (fs.existsSync(candidate)) {
          // 找到了，使用这个子目录
          return copyMingw(path.join(selectedDir, d), installDir, fs);
        }
      }
      return { ok: false, error: '未找到 g++.exe，请确保选择的是 mingw64 文件夹（包含 bin\\g++.exe）' };
    }
    
    return copyMingw(selectedDir, installDir, fs);
  });
  
  function copyMingw(srcDir, destDir, fs) {
    try {
      // 如果目标已存在，先删除
      if (fs.existsSync(destDir)) {
        fs.rmSync(destDir, { recursive: true, force: true });
      }
      // 创建目标目录的父目录
      fs.mkdirSync(path.dirname(destDir), { recursive: true });
      // 复制整个目录
      function copyDir(src, dest) {
        fs.mkdirSync(dest, { recursive: true });
        const entries = fs.readdirSync(src, { withFileTypes: true });
        for (const entry of entries) {
          const srcPath = path.join(src, entry.name);
          const destPath = path.join(dest, entry.name);
          if (entry.isDirectory()) {
            copyDir(srcPath, destPath);
          } else {
            fs.copyFileSync(srcPath, destPath);
          }
        }
      }
      copyDir(srcDir, destDir);
      // 验证
      const gppPath = path.join(destDir, 'bin', 'g++.exe');
      if (!fs.existsSync(gppPath)) {
        throw new Error('安装完成但未找到 g++.exe');
      }
      compilerCache = null;
      return { ok: true, gccPath: gppPath };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

// ---- 洛谷广告内容过滤 ----
function filterLuoguAds(text) {
  if (!text) return '';
  
  // 强广告特征：出现即整段移除
  const strongKeywords = [
    '广告',
    '洛谷出品',
    '官方网店',
    '绝赞热卖',
    'item.taobao.com',
    'luogu.com.cn/store',
    '扫码关注',
    '微信公众号',
    '限时特惠',
    '优惠券'
  ];
  
  // 弱广告特征：需配合营销上下文（链接/购买字样）才移除
  const weakKeywords = ['教材', '购买', '网课', '课程报名', 'QQ群', '交流群', '欢迎加入'];
  
  const blocks = text.split(/\n\s*\n/);
  const kept = [];
  
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    
    const lower = trimmed.toLowerCase();
    
    // 强特征直接命中
    let isAd = strongKeywords.some(kw => lower.includes(kw.toLowerCase()));
    
    // 弱特征需配合营销上下文
    if (!isAd) {
      const hasWeak = weakKeywords.some(kw => lower.includes(kw.toLowerCase()));
      if (hasWeak) {
        const hasMarketing = /\[.+\]\(.+\)/.test(trimmed) ||   // 含 markdown 链接
                             /https?:\/\//.test(trimmed) ||      // 含 URL
                             /[【】]/.test(trimmed);              // 含营销括号
        if (hasMarketing) isAd = true;
      }
    }
    
    if (isAd) continue;
    kept.push(trimmed);
  }
  
  return kept.join('\n\n').trim();
}

// 洛谷 limits 归一化 -> { time: 毫秒, memory: KB }
// 原文里 time/memory 都是「每个测试点一项」的数组，界面只需要一个数，取最大值。
function normalizeLuoguLimits(limits) {
  if (!limits || typeof limits !== 'object') return null;
  const pickMax = (v) => {
    const arr = Array.isArray(v) ? v : [v];
    const nums = arr.map(x => parseInt(x, 10)).filter(x => Number.isFinite(x) && x > 0);
    return nums.length ? Math.max.apply(null, nums) : null;
  };
  const time = pickMax(limits.time);
  const memory = pickMax(limits.memory);
  return (time || memory) ? { time: time, memory: memory } : null;
}

// ---- 洛谷题目解析 ----
function parseLuoguProblem(html, problemId) {
  const result = {
    id: problemId,
    title: '',
    difficulty: 0,
    limits: null,
    tags: [],
    background: '',
    description: '',
    inputFormat: '',
    outputFormat: '',
    samples: [],
    hint: '',
    url: `https://www.luogu.com.cn/problem/${problemId}`
  };

  try {
    // 找到内嵌 JSON 数据的 script 标签
    // 洛谷页面在第二个 script 标签中放置了原始 JSON 数据
    const scriptMatches = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
    let jsonData = null;
    
    for (const m of scriptMatches) {
      const content = m[1].trim();
      if (content.startsWith('{') && content.includes('"template"') && content.includes('"problem"')) {
        try {
          jsonData = JSON.parse(content);
          break;
        } catch(e) {
          // 继续试下一个
        }
      }
    }
    
    if (!jsonData) {
      // 备用：尝试旧格式 _feInjection
      const oldMatch = html.match(/window\._feInjection\s*=\s*JSON\.parse\("([^"]+)"\)/);
      if (oldMatch) {
        try {
          const decoded = JSON.parse('"' + oldMatch[1] + '"');
          jsonData = JSON.parse(decoded);
        } catch(e) {}
      }
    }
    
    if (jsonData && jsonData.data && jsonData.data.problem) {
      const p = jsonData.data.problem;
      
      // 标题
      result.title = p.name || p.title || '';
      
      // 难度
      if (p.difficulty !== undefined) result.difficulty = p.difficulty;
      
      // 标签（数字 ID，尝试转成名称）
      if (p.tags && Array.isArray(p.tags)) {
        result.tags = p.tags.map(t => {
          if (typeof t === 'string') return t;
          if (typeof t === 'number') return 'tag-' + t;
          if (t && t.name) return t.name;
          return String(t);
        });
      }
      
      // 时间/内存限制（就在这份已经拿到的 JSON 里，不需要额外请求）
      result.limits = normalizeLuoguLimits(p.limits);
      
      // 题目内容（在 content 或 translations 中）
      let content = null;
      if (p.content && typeof p.content === 'object') {
        content = p.content;
      } else if (jsonData.data.translations) {
        // 优先中文
        if (jsonData.data.translations['zh-CN']) {
          content = jsonData.data.translations['zh-CN'];
        } else {
          // 取第一个翻译
          const keys = Object.keys(jsonData.data.translations);
          if (keys.length > 0) content = jsonData.data.translations[keys[0]];
        }
      }
      
      if (content) {
        result.background = content.background || '';
        result.description = content.description || '';
        result.inputFormat = content.formatI || content.inputFormat || '';
        result.outputFormat = content.formatO || content.outputFormat || '';
        result.hint = filterLuoguAds(content.hint || '');
        result.background = filterLuoguAds(result.background);
      }
      
      // 样例
      if (p.samples && Array.isArray(p.samples)) {
        result.samples = p.samples
          .filter(s => Array.isArray(s) && s.length >= 2)
          .map(s => ({
            input: s[0] || '',
            output: s[1] || ''
          }));
      }
    }
    
    // 如果 JSON 方式没拿到标题，用 HTML 兜底
    if (!result.title) {
      const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
      if (titleMatch) {
        result.title = titleMatch[1].replace(/<[^>]+>/g, '').trim();
      }
    }
    
  } catch (e) {
    console.error('Parse Luogu problem error:', e.message);
  }
  
  return result;
}

// === 快捷方式兜底 ===
// 安装包的 NSIS 脚本在某些环境下（提权安装、多用户机器、安全软件拦截）会把快捷方式
// 写到别的用户桌面或公共桌面，导致安装完成后当前用户桌面上看不到图标。
// 这里在安装版首次启动时补一次：用 Electron 自带的 shell.writeShortcutLink，
// 以当前登录用户的身份写到自己桌面 / 开始菜单，保证一定可见。
// 只补一次；用户手动删掉后不会再自动长回来。免装版（便携版）完全不碰。
function ensureShortcuts() {
  try {
    if (process.env.PORTABLE_EXECUTABLE_DIR) return;
    if (process.env.PORTABLE_EXECUTABLE_FILE) return;
    if (isPortable) return;

    const fs = require('fs');
    const { shell } = require('electron');
    const marker = path.join(app.getPath('userData'), '.shortcut_done');
    if (fs.existsSync(marker)) return;

    const name = 'C++ Playground';
    const opts = {
      target: process.execPath,
      cwd: path.dirname(process.execPath),
      description: 'C++ Playground - 本地 C++/Python 编译器',
      icon: process.execPath,
      iconIndex: 0
    };

    const candidates = [];
    try { candidates.push(path.join(app.getPath('desktop'), name + '.lnk')); } catch (_) {}
    try {
      candidates.push(path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', name + '.lnk'));
    } catch (_) {}

    let ok = false;
    for (const lnk of candidates) {
      try {
        if (fs.existsSync(lnk)) { ok = true; continue; }
        if (shell.writeShortcutLink(lnk, 'create', opts)) ok = true;
      } catch (_) {}
    }
    if (ok) {
      try { fs.writeFileSync(marker, String(Date.now()), 'utf8'); } catch (_) {}
    }
  } catch (_) {}
}

// 单实例锁，防止重复启动
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  
  app.whenReady().then(async () => { 
    createWindow(); 
    // 安装版首次启动时补齐桌面/开始菜单快捷方式（详见 ensureShortcuts 注释）
    ensureShortcuts();
    // 安装版首次启动的 g++ 自动下载已移到 registerIpc() 内部执行
    // （downloadGpp 是 registerIpc 的局部函数，在此处作用域不可见）
  });

  // 开发/测试钩子：下载完成后自动退出（仅当设置 CPP_AI_DL_TEST 时启用）
  if (process.env.CPP_AI_DL_TEST) {
    app.whenReady().then(async () => {
      setTimeout(async () => {
        try {
          await runAiModelDownload((p) => console.log('[ai-dl]', JSON.stringify(p)));
          console.log('DL_TEST_OK');
          app.exit(0);
        } catch (e) {
          console.error('DL_TEST_FAIL:', e.message || e);
          app.exit(1);
        }
      }, 3000);
    });
  }

  // 开发/测试钩子：真实蓝奏云整包下载验证（CPP_AI_REAL_TEST=1 使用正式链接跑完整流水线）
  if (process.env.CPP_AI_REAL_TEST) {
    app.whenReady().then(async () => {
      setTimeout(async () => {
        try {
          await runAiModelDownload((p) => console.log('[ai-real]', JSON.stringify(p)));
          console.log('REAL_TEST_OK');
          app.exit(0);
        } catch (e) {
          console.error('REAL_TEST_FAIL:', e.message || e);
          app.exit(1);
        }
      }, 3000);
    });
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// 退出时关闭本地大模型服务
app.on('before-quit', () => {
  localLLM.stop();
});
