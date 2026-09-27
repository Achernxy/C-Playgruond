// 图标生成器：把一张方形 PNG logo 转成打包需要的图标文件。
//
// 用法（必须用 Electron 运行，因为要用 canvas 做高质量缩放）：
//   set ELECTRON_RUN_AS_NODE=            （不要设置）
//   .\node_modules\electron\dist\electron.exe scripts\make-icons.js [源图路径]
//
// 默认源图：build/logo-source.png
// 输出：
//   build/icon.ico      —— 7 个尺寸（16/24/32/48/64/128/256），每个都存成 PNG。
//                          会被打进：免装版 exe、安装版 exe、以及安装完成后的运行程序
//                          （运行程序由 scripts/afterPack.js 用 rcedit 注入，因为
//                            signAndEditExecutable=false 时 electron-builder 不会自动改 exe 资源）
//   build/icon.png      —— 512x512，打包图标源
//   resources/icon.png  —— 512x512，主进程创建窗口时用的窗口/任务栏图标
//
// 旧图标会另存为 *.bak-<时间戳>，方便回退。
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const RES = path.join(ROOT, 'resources');
const SRC = process.argv[2] ? path.resolve(process.argv[2]) : path.join(BUILD, 'logo-source.png');

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const PNG_MAX = 512;

function renderScript(size) {
  return `(function(){
    return new Promise(function(resolve){
      var img = document.getElementById('s');
      function draw(){
        var c = document.createElement('canvas');
        c.width = ${size}; c.height = ${size};
        var ctx = c.getContext('2d');
        var sc = Math.min(${size}/img.naturalWidth, ${size}/img.naturalHeight);
        var dw = Math.max(1, Math.round(img.naturalWidth*sc));
        var dh = Math.max(1, Math.round(img.naturalHeight*sc));
        var x = Math.round((${size}-dw)/2), y = Math.round((${size}-dh)/2);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.clearRect(0,0,${size},${size});
        ctx.drawImage(img, x, y, dw, dh);
        resolve(c.toDataURL('image/png'));
      }
      if (img.complete && img.naturalWidth > 0) draw();
      else { img.onload = draw; img.onerror = function(){ resolve(''); }; }
    });
  })()`;
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 600, height: 600 });
  const wc = win.webContents;
  try {
    if (!fs.existsSync(SRC)) throw new Error('找不到源图：' + SRC);
    const b64 = fs.readFileSync(SRC).toString('base64');
    const html = '<html><body><img id="s" src="data:image/png;base64,' + b64 + '"></body></html>';
    await wc.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));

    // 先看一眼源图：是否方形、四角是否透明（决定图标会不会显得是硬边方块）
    const info = await wc.executeJavaScript(`(function(){
      return new Promise(function(resolve){
        var img = document.getElementById('s');
        function run(){
          var c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          var ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0);
          var d = ctx.getImageData(0, 0, c.width, c.height).data;
          var W = c.width, H = c.height, transparent = 0;
          for (var i = 3; i < d.length; i += 4) if (d[i] < 8) transparent++;
          function px(x, y) { var i = (y * W + x) * 4; return [d[i], d[i+1], d[i+2], d[i+3]].join(','); }
          resolve({
            w: W, h: H,
            transparentRatio: +(transparent / (W * H)).toFixed(4),
            corners: [px(0,0), px(W-1,0), px(0,H-1), px(W-1,H-1)]
          });
        }
        if (img.complete && img.naturalWidth > 0) run();
        else { img.onload = run; img.onerror = function(){ resolve(null); }; }
      });
    })()`);
    if (!info) throw new Error('源图加载失败');
    console.log('源图: ' + SRC);
    console.log('  尺寸 ' + info.w + ' x ' + info.h + (info.w === info.h ? '（方形，合适）' : '（非方形，会居中留白）'));
    console.log('  完全透明像素占比 ' + (info.transparentRatio * 100).toFixed(2) + '%');
    console.log('  四角 RGBA: ' + info.corners.join('  |  '));

    const results = {};
    for (const size of ICO_SIZES.concat([PNG_MAX])) {
      const dataUrl = await wc.executeJavaScript(renderScript(size));
      if (!dataUrl) throw new Error('绘制失败 size=' + size);
      results[size] = Buffer.from(dataUrl.split(',')[1], 'base64');
    }

    let offset = 6 + 16 * ICO_SIZES.length;
    const parts = [];
    const head = Buffer.alloc(6);
    head.writeUInt16LE(0, 0);
    head.writeUInt16LE(1, 2);
    head.writeUInt16LE(ICO_SIZES.length, 4);
    parts.push(head);
    const payloads = [];
    for (const s of ICO_SIZES) {
      const data = results[s];
      const e = Buffer.alloc(16);
      const dim = s >= 256 ? 0 : s;
      e.writeUInt8(dim, 0);
      e.writeUInt8(dim, 1);
      e.writeUInt16LE(1, 4);          // 1 = 调色板颜色数（真彩无调色板，占位）
      e.writeUInt16LE(32, 6);         // 32bpp
      e.writeUInt32LE(data.length, 8);
      e.writeUInt32LE(offset, 12);
      offset += data.length;
      parts.push(e);
      payloads.push(data);
    }
    for (const d of payloads) parts.push(d);
    const ico = Buffer.concat(parts);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const f of [path.join(BUILD, 'icon.ico'), path.join(BUILD, 'icon.png'), path.join(RES, 'icon.png')]) {
      if (fs.existsSync(f)) fs.copyFileSync(f, f + '.bak-' + stamp);
    }
    fs.writeFileSync(path.join(BUILD, 'icon.ico'), ico);
    fs.writeFileSync(path.join(BUILD, 'icon.png'), results[PNG_MAX]);
    fs.writeFileSync(path.join(RES, 'icon.png'), results[PNG_MAX]);

    console.log('');
    console.log('OK  build/icon.ico        ' + ico.length + ' 字节  尺寸 ' + ICO_SIZES.join(', '));
    console.log('OK  build/icon.png        ' + results[PNG_MAX].length + ' 字节  ' + PNG_MAX + 'x' + PNG_MAX);
    console.log('OK  resources/icon.png    ' + results[PNG_MAX].length + ' 字节  ' + PNG_MAX + 'x' + PNG_MAX);
    console.log('下一步：npx electron-builder --win --x64');
    win.destroy();
    app.exit(0);
  } catch (e) {
    console.error('ERR ' + (e && e.message ? e.message : e));
    app.exit(1);
  }
});
