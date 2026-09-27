// electron-builder afterPack 钩子：在 packaging 完成后、生成 NSIS/portable 前，
// 用 rcedit 完成两件事：
//   1) 把作者图标注入到真正的运行程序 exe（win-unpacked\C++ Playground.exe）中；
//   2) 把发行者/公司等版本信息写入运行程序 exe（覆盖 Electron 默认的 "GitHub, Inc."）。
// 原因：signAndEditExecutable=false 会跳过 electron-builder 对 app exe 的资源编辑，
// 导致运行程序 exe 仍显示 Electron 默认图标与 GitHub 公司信息（安装包/免装版外壳不受影响）。
'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const PUBLISHER = 'C++ Playground';
// 版本号统一从 package.json 读取，避免与安装包版本不一致
let VERSION = '1.6.0';
try {
  VERSION = require(path.join(__dirname, '..', 'package.json')).version || VERSION;
} catch (_) {}

exports.default = async function afterPack(context) {
  const appOutDir = context.appOutDir;
  const rcedit = findRcedit();
  if (!rcedit) {
    console.log('[afterPack] 未找到 rcedit，跳过图标/发行者注入。');
    return;
  }

  const exeCandidates = [
    path.join(appOutDir, 'C++ Playground.exe'),
    path.join(appOutDir, 'C++Playground.exe'),
  ];
  const exe = exeCandidates.find((p) => fs.existsSync(p));
  if (!exe) {
    console.log('[afterPack] 未找到目标运行 exe，跳过图标/发行者注入。');
    return;
  }

  const icon = path.join(context.packager.buildResourcesDir || 'build', 'icon.ico');
  console.log('[afterPack] 注入图标 + 发行者 -> ' + exe);
  try {
    execFileSync(rcedit, [exe, '--set-icon', icon], { stdio: 'inherit' });
    console.log('[afterPack] 图标注入成功。');
  } catch (e) {
    console.log('[afterPack] 图标注入失败：' + e.message);
  }

  // 注入版本信息字符串（发行者/公司等）
  try {
    const args = [exe,
      '--set-version-string', 'CompanyName', PUBLISHER,
      '--set-version-string', 'ProductName', PUBLISHER,
      '--set-version-string', 'FileDescription', PUBLISHER + ' - 本地 C++/Python 编译器',
      '--set-version-string', 'LegalCopyright', 'Copyright © 2026 ' + PUBLISHER,
      '--set-version-string', 'OriginalFilename', 'C++ Playground.exe',
      '--set-file-version', VERSION + '.0',
      '--set-product-version', VERSION + '.0'
    ];
    execFileSync(rcedit, args, { stdio: 'inherit' });
    console.log('[afterPack] 发行者信息注入成功（' + PUBLISHER + ' v' + VERSION + '）。');
  } catch (e) {
    console.log('[afterPack] 发行者信息注入失败：' + e.message);
  }
};

function findRcedit() {
  const cacheRoot = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'winCodeSign')
    : '';
  if (!cacheRoot) return null;
  let found = null;
  try {
    for (const dir of fs.readdirSync(cacheRoot)) {
      const p = path.join(cacheRoot, dir, 'rcedit-x64.exe');
      if (fs.existsSync(p)) {
        found = p;
        break;
      }
    }
  } catch (_) {}
  return found;
}
