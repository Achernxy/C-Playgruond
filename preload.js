const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 编译器检测
  getLocalCompiler: () => ipcRenderer.invoke('get-local-compiler'),
  
  // 文件操作
  saveFile: (args) => ipcRenderer.invoke('save-file', args),
  openFile: () => ipcRenderer.invoke('open-file'),
  
  // 下载编译器
  downloadCompiler: () => ipcRenderer.invoke('download-compiler'),
  onDownloadProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('download-progress', handler);
    return () => ipcRenderer.removeListener('download-progress', handler);
  },
  
  // 交互式运行
  runInteractive: (args) => ipcRenderer.invoke('run-interactive', args),
  sendStdin: (data) => ipcRenderer.invoke('send-stdin', data),
  killProcess: () => ipcRenderer.invoke('kill-process'),
  onRunEvent: (cb) => {
    const handler = (_e, evt) => cb(evt);
    ipcRenderer.on('run-event', handler);
    return () => ipcRenderer.removeListener('run-event', handler);
  },

  // 安装 MinGW
  installMingw: () => ipcRenderer.invoke('install-mingw'),

  // AI 聊天（主进程调用，绕过CORS）
  aiChat: (args) => ipcRenderer.invoke('ai-chat', args),

  // AI 流式聊天（边生成边推送）
  aiChatStream: (args) => ipcRenderer.send('ai-chat-stream', args),
  onAiChatStream: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('ai-chat-stream-event', handler);
    return () => ipcRenderer.removeListener('ai-chat-stream-event', handler);
  },

  // 断点调试
  debugStart: (args) => ipcRenderer.invoke('debug-start', args),
  debugCommand: (cmd, arg) => ipcRenderer.invoke('debug-command', cmd, arg),
  debugStop: () => ipcRenderer.invoke('debug-stop'),
  onDebugEvent: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('debug-event', handler);
    return () => ipcRenderer.removeListener('debug-event', handler);
  },

  // 内置 AI 模型下载
  aiModelStatus: () => ipcRenderer.invoke('ai-model-status'),
  aiModelDownload: () => ipcRenderer.invoke('ai-model-download'),
  onAiModelProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('ai-model-progress', handler);
    return () => ipcRenderer.removeListener('ai-model-progress', handler);
  },

  // 洛谷
  luoguGetProblem: (problemId) => ipcRenderer.invoke('luogu-get-problem', problemId),
  luoguOpenSubmit: (problemId) => ipcRenderer.invoke('luogu-open-submit', problemId)
});
