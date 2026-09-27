/**
 * AI Service - 统一 AI 聊天服务模块
 *
 * 功能：
 *   - 多提供商自动降级：DeepSeek → 豆包 → 智谱 → SiliconFlow → Groq
 *   - 支持普通调用 (chat) 和流式输出 (chatStream)
 *   - 支持多模态（图片输入）
 *   - 内置 keep-alive 连接复用，加速请求
 *   - 连接超时快速降级（15s 连不上自动换下一个）
 *   - 内置代码助手专用 system prompt
 *
 * 用法：
 *   const ai = require('./ai-service');
 *
 *   // 普通调用
 *   const result = await ai.chat({
 *     systemPrompt: '你是 C++ 专家',
 *     userPrompt: '写一个快速排序',
 *     images: [],           // 可选，base64 图片数组
 *     keys: { dsKey, dbKey, zpKey, sfKey, gqKey },
 *     models: { dsModel, dbModel, zpModel }
 *   });
 *   // => { ok: true, text: '...', provider: 'DeepSeek/deepseek-v4-pro' }
 *
 *   // 流式调用
 *   await ai.chatStream({
 *     systemPrompt, userPrompt, images, keys, models,
 *     onDelta: (chunk) => { ... },   // 每次增量回调
 *     onDone:  (fullText, provider) => { ... },
 *     onError: (error, provider) => { ... }
 *   });
 */

'use strict';

const https = require('https');
const http  = require('http');

const APP_VERSION = '1.2.0';

// ========== 连接复用：keep-alive Agent ==========
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8, keepAliveMsecs: 60000 });
const httpAgent  = new http.Agent ({ keepAlive: true, maxSockets: 8, keepAliveMsecs: 60000 });

// ========== 内置代码助手 System Prompt ==========
const CODE_ASSISTANT_PROMPT = `你是一名资深 C++ / Python 编程助教，名叫 C++ Playground AI。

你的职责：
1. 解释代码原理，指出错误并给出修复方案
2. 按用户要求编写、重构或优化代码
3. 代码风格：简洁、规范、注释适度、可直接运行
4. 回答时优先使用中文，专业术语可以保留英文
5. 遇到编译/运行错误，先分析根本原因，再给出修改后的完整代码
6. 不要虚构不存在的 API 或头文件
7. 如果用户提供了截图中的错误信息，仔细分析错误行号和错误信息

输出格式要求：
- 代码用 Markdown 代码块包裹（\`\`\`cpp 或 \`\`\`python）
- 解释分段清晰，重点突出
- 如涉及多处修改，明确指出每一处改了什么`;

// ========== 通用 HTTP 请求（支持重定向、超时、连接复用）==========
function httpRequest(url, method, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
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
      agent: isHttps ? httpsAgent : httpAgent
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

    // 连接建立超时：网络卡顿时快速失败，便于降级
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

// ========== 流式 HTTP 请求（SSE）==========
function httpRequestStream(url, method, headers, body, timeoutMs, onChunk, onDone, onError) {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === 'https:';
  const lib = isHttps ? https : http;
  const finalHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) C++Playground/' + APP_VERSION,
    'Accept': 'text/event-stream',
    'Cache-Control': 'no-cache',
    ...headers
  };
  if (body) finalHeaders['Content-Length'] = Buffer.byteLength(body);

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: method,
    headers: finalHeaders,
    agent: isHttps ? httpsAgent : httpAgent
  };

  const req = lib.request(options, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      httpRequestStream(res.headers.location, method, headers, body, timeoutMs, onChunk, onDone, onError);
      return;
    }
    if (res.statusCode !== 200) {
      let errBody = '';
      res.on('data', (c) => errBody += c);
      res.on('end', () => onError(new Error('HTTP ' + res.statusCode + ': ' + errBody.substring(0, 200))));
      return;
    }
    res.setEncoding('utf8');
    let buffer = '';
    res.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.substring(0, idx).trim();
        buffer = buffer.substring(idx + 1);
        if (!line) continue;
        if (line.startsWith('data:')) {
          const data = line.substring(5).trim();
          if (data === '[DONE]') { onDone(); return; }
          try {
            const obj = JSON.parse(data);
            const delta = obj?.choices?.[0]?.delta?.content;
            if (delta) onChunk(delta);
          } catch (_) { /* 忽略非 JSON 行 */ }
        }
      }
    });
    res.on('end', () => { onDone(); });
  });

  req.on('error', onError);
  req.setTimeout(timeoutMs || 60000, () => { req.destroy(); onError(new Error('流式请求超时')); });

  if (body) req.write(body);
  req.end();

  return () => { try { req.destroy(); } catch (_) {} };
}

// ========== 构建消息体 ==========
function buildMessages(systemPrompt, userPrompt, images) {
  const hasImage = images && images.length > 0;
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
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: userContent }
  ];
}

// ========== 提供商定义 ==========
// 每个 provider 工厂返回一个可调用对象，含 call / callStream 方法
function buildProviderList({ keys, models, hasImage }) {
  const providers = [];

  // 1. DeepSeek V4（最强，付费优先）
  if (keys.dsKey) {
    const dsModels = (models.dsModel && models.dsModel !== 'auto')
      ? [models.dsModel]
      : hasImage
        ? ['deepseek-v4-flash-vision-exp']
        : ['deepseek-v4-pro', 'deepseek-v4-flash'];
    const timeout = hasImage ? 90000 : 60000;
    for (const m of dsModels) {
      providers.push({
        label: 'DeepSeek/' + m,
        url:   'https://api.deepseek.com/v1/chat/completions',
        key:   keys.dsKey,
        model: m,
        timeout,
        supportsImage: hasImage
      });
    }
  }

  // 2. 豆包 Seed 2.0（火山引擎方舟，每天 200 万 Token 免费）
  if (keys.dbKey) {
    const dbModels = (models.dbModel && models.dbModel !== 'auto')
      ? [models.dbModel]
      : ['doubao-seed-2-0-lite-260428', 'doubao-seed-2-0-mini-260428'];
    const timeout = hasImage ? 90000 : 60000;
    for (const m of dbModels) {
      providers.push({
        label: '豆包/' + m,
        url:   'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
        key:   keys.dbKey,
        model: m,
        timeout,
        supportsImage: true
      });
    }
  }

  // 3. 智谱 AI（永久免费模型）
  if (keys.zpKey) {
    const zpModels = (models.zpModel && models.zpModel !== 'auto')
      ? [models.zpModel]
      : hasImage
        ? ['glm-4.6v-flash', 'glm-4.1v-thinking-flash']
        : ['glm-4.7-flash', 'glm-4-flash'];
    const timeout = hasImage ? 90000 : 45000;
    for (const m of zpModels) {
      providers.push({
        label: '智谱AI/' + m,
        url:   'https://open.bigmodel.cn/api/paas/v4/chat/completions',
        key:   keys.zpKey,
        model: m,
        timeout,
        supportsImage: hasImage
      });
    }
  }

  // 4. SiliconFlow（免费模型兜底）
  if (keys.sfKey && !hasImage) {
    const sfModels = [
      'THUDM/GLM-4-9B-0414',
      'THUDM/GLM-Z1-9B-0414',
      'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',
      'deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B'
    ];
    for (const m of sfModels) {
      providers.push({
        label: 'SiliconFlow/' + m.split('/').pop(),
        url:   'https://api.siliconflow.cn/v1/chat/completions',
        key:   keys.sfKey,
        model: m,
        timeout: 60000,
        supportsImage: false
      });
    }
  }

  // 5. Groq（速度快，需代理）
  if (keys.gqKey && !hasImage) {
    const gqModels = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'gemma2-9b-it'];
    for (const m of gqModels) {
      providers.push({
        label: 'Groq/' + m,
        url:   'https://api.groq.com/openai/v1/chat/completions',
        key:   keys.gqKey,
        model: m,
        timeout: 60000,
        supportsImage: false
      });
    }
  }

  return providers;
}

// ========== 普通聊天（自动降级）==========
async function chat({ systemPrompt, userPrompt, images, keys, models }) {
  const hasImage = images && images.length > 0;
  const providers = buildProviderList({ keys, models, hasImage });
  const errors = [];

  for (const p of providers) {
    // 如果需要图片但此提供商不支持，跳过
    if (hasImage && !p.supportsImage) continue;
    try {
      const messages = buildMessages(systemPrompt, userPrompt, hasImage ? images : null);
      const body = JSON.stringify({ model: p.model, messages });
      const result = await httpRequest(p.url, 'POST', {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + p.key
      }, body, p.timeout);

      if (result.status === 200) {
        const data = JSON.parse(result.body);
        const text = data?.choices?.[0]?.message?.content;
        if (text) return { ok: true, text, provider: p.label };
      } else if (result.status === 401) {
        errors.push(p.label + ': 密钥无效 (401)');
        break; // 同一提供商下其他模型也会 401，直接跳出
      } else {
        errors.push(p.label + ': HTTP ' + result.status + ' ' + result.body.substring(0, 120));
      }
    } catch (e) {
      errors.push(p.label + ': ' + e.message);
    }
  }

  const detail = errors.length > 0 ? errors.join('; ') : '没有可用的 AI 提供商';
  return { ok: false, error: 'AI 调用失败：' + detail };
}

// ========== 流式聊天（自动降级）==========
/**
 * 流式调用：逐个提供商尝试，第一个成功就持续推送增量，失败则自动降级到下一个
 *
 * @param {Object} opts
 * @param {string} opts.systemPrompt
 * @param {string} opts.userPrompt
 * @param {string[]} [opts.images]
 * @param {Object} opts.keys   { dsKey, dbKey, zpKey, sfKey, gqKey }
 * @param {Object} opts.models { dsModel, dbModel, zpModel }
 * @param {(chunk:string)=>void} opts.onDelta   - 增量文本回调
 * @param {(fullText:string, provider:string)=>void} opts.onDone - 完成回调
 * @param {(err:Error, provider:string)=>boolean|void} opts.onError - 单个提供商失败，返回 true 可中断
 */
function chatStream({ systemPrompt, userPrompt, images, keys, models, onDelta, onDone, onError }) {
  const hasImage = images && images.length > 0;
  const providers = buildProviderList({ keys, models, hasImage });
  let idx = 0;
  let cancelled = false;

  function tryNext() {
    if (cancelled) return;
    if (idx >= providers.length) {
      onError && onError(new Error('所有 AI 提供商均调用失败'), 'all');
      return;
    }
    const p = providers[idx++];
    if (hasImage && !p.supportsImage) { tryNext(); return; }

    let fullText = '';
    let finished = false;

    const cancel = httpRequestStream(
      p.url, 'POST',
      { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + p.key },
      JSON.stringify({
        model: p.model,
        stream: true,
        messages: buildMessages(systemPrompt, userPrompt, hasImage ? images : null)
      }),
      p.timeout,
      // onChunk
      (chunk) => {
        fullText += chunk;
        onDelta && onDelta(chunk);
      },
      // onDone
      () => {
        if (finished) return;
        finished = true;
        if (fullText.trim().length > 0) {
          onDone && onDone(fullText, p.label);
        } else {
          // 空回复，尝试下一个
          onError && onError(new Error('空回复'), p.label);
          tryNext();
        }
      },
      // onError
      (err) => {
        if (finished) return;
        finished = true;
        const shouldStop = onError && onError(err, p.label);
        if (!shouldStop) tryNext();
      }
    );

    // 暴露取消方法（首次成功后可用于中断）
    if (!streamCancel) {
      streamCancel = () => { cancelled = true; cancel(); };
    }
  }

  let streamCancel = null;
  tryNext();

  return () => { if (streamCancel) streamCancel(); };
}

// ========== 导出 ==========
module.exports = {
  chat,
  chatStream,
  CODE_ASSISTANT_PROMPT,
  httpRequest,
  httpRequestStream
};
