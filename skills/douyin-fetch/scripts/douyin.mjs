// 抖音视频获取：用真 Chrome 打开页面（抖音自己的 JS 负责接口签名），通过 CDP 拦截接口 JSON 提取视频信息并下载。
//
// 用法（需要 Node >= 22 和 Google Chrome / Chromium；WSL 里用 Windows 的 node.exe）:
//   node douyin.mjs video <ID | 链接 | 分享文案> ...   下载指定视频
//   node douyin.mjs feed   [--limit 20] [--download N]  首页推荐流
//   node douyin.mjs search <关键词> [--limit 20] [--download N] [--headful]
// 通用选项:
//   --out <目录>      输出目录（默认 ./douyin_output）
//   --profile <目录>  Chrome 配置目录（默认 ~/.douyin-fetch/chrome-profile，保存验证/登录状态）
//   --headful         显示浏览器窗口，用于手动过验证码/扫码登录
//
// search 页会触发验证码：先加 --headful 跑一次，在弹出的窗口里手动过验证/扫码登录，
// 状态保存在 profile 目录，之后可去掉 --headful。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const [mode, ...rest] = process.argv.slice(2);
const VALUE_FLAGS = ['--limit', '--download', '--out', '--profile', '--port'];
const opt = name => {
  const i = rest.indexOf(name);
  return i < 0 ? undefined : rest[i + 1];
};
const headful = rest.includes('--headful');
const limit = Number(opt('--limit') ?? 20);
const downloadN = Number(opt('--download') ?? (mode === 'video' ? Infinity : 0));
const positional = rest.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(rest[i - 1]));

const outDir = path.resolve(opt('--out') ?? 'douyin_output');
const profileDir = path.resolve(opt('--profile') ?? path.join(os.homedir(), '.douyin-fetch', 'chrome-profile'));
const PORT = Number(opt('--port') ?? 9333);
const CHROME = findChrome();

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = {
    win32: [
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    ],
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
  }[process.platform] || [];
  const found = candidates.find(p => fs.existsSync(p));
  if (!found) throw new Error('找不到 Chrome，请设置环境变量 CHROME_PATH 指向 chrome 可执行文件');
  return found;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(outDir, { recursive: true });

// ---------- CDP ----------
async function openBrowser() {
  const proc = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    ...(headful ? [] : ['--headless=new']),
    '--no-first-run', '--no-default-browser-check', '--window-size=1280,900',
    '--disable-blink-features=AutomationControlled',
    'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl;
  for (let i = 0; i < 50 && !wsUrl; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      wsUrl = list.find(t => t.type === 'page')?.webSocketDebuggerUrl;
    } catch {}
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) throw new Error('Chrome CDP 未就绪（是否已有同端口的 Chrome 在跑？）');

  const ws = new WebSocket(wsUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  let seq = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) {
      listeners.forEach(fn => fn(msg));
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  // 收集所有 /aweme/ 接口响应体
  const responses = [];
  const inflight = new Map();
  listeners.push(async msg => {
    if (msg.method === 'Network.responseReceived' && /\/aweme\/v\d\/web\//.test(msg.params.response.url)) {
      inflight.set(msg.params.requestId, msg.params.response.url);
    }
    if (msg.method === 'Network.loadingFinished' && inflight.has(msg.params.requestId)) {
      const url = inflight.get(msg.params.requestId);
      inflight.delete(msg.params.requestId);
      try {
        const r = await send('Network.getResponseBody', { requestId: msg.params.requestId });
        responses.push({ url, text: r.base64Encoded ? Buffer.from(r.body, 'base64').toString() : r.body });
      } catch {}
    }
  });

  await send('Network.enable');
  await send('Page.enable');
  const ua = (await send('Browser.getVersion')).userAgent.replace('HeadlessChrome', 'Chrome');
  await send('Network.setUserAgentOverride', { userAgent: ua, acceptLanguage: 'zh-CN,zh;q=0.9' });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});",
  });

  return {
    ua,
    responses,
    send,
    goto: url => send('Page.navigate', { url }),
    title: async () => (await send('Runtime.evaluate', { expression: 'document.title' })).result.value,
    scroll: () => send('Runtime.evaluate', { expression: 'window.scrollBy(0, 3000)' }),
    screenshot: async file => {
      const s = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
    },
    close: () => { ws.close(); proc.kill(); },
  };
}

// ---------- 解析 ----------
// 接口结构各不相同（搜索 data[].aweme_info、推荐 cards[].aweme 是 JSON 字符串、详情 aweme_detail…），
// 递归找所有带 aweme_id + video 的对象。
function extractAwemes(text, into) {
  const walk = node => {
    if (typeof node === 'string') {
      if (node.length > 50 && node[0] === '{' && node.includes('aweme_id')) {
        try { walk(JSON.parse(node)); } catch {}
      }
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (node.aweme_id && node.video?.play_addr && !into.has(node.aweme_id)) into.set(node.aweme_id, node);
    for (const v of Object.values(node)) walk(v);
  };
  for (const line of text.split('\n')) {
    try { walk(JSON.parse(line)); } catch {}
  }
}

function collect(responses, urlFilter = () => true) {
  const map = new Map();
  for (const r of responses) if (urlFilter(r.url)) extractAwemes(r.text, map);
  return map;
}

// 选清晰度：优先 H.264（剪辑软件兼容性最好），同编码取最高码率
function pickSource(a) {
  const v = a.video;
  const rates = (v.bit_rate || []).filter(b => b.play_addr?.url_list?.length);
  rates.sort((x, y) => (x.is_h265 - y.is_h265) || (y.bit_rate - x.bit_rate));
  const best = rates[0];
  return {
    urls: best ? best.play_addr.url_list : v.play_addr.url_list,
    width: best?.play_addr?.width ?? v.width,
    height: best?.play_addr?.height ?? v.height,
    codec: best ? (best.is_h265 ? 'h265' : 'h264') : 'unknown',
  };
}

function summarize(a) {
  const src = pickSource(a);
  return {
    aweme_id: a.aweme_id,
    desc: a.desc,
    author: a.author?.nickname,
    likes: a.statistics?.digg_count,
    duration_s: Math.round((a.video?.duration || a.duration || 0) / 1000),
    resolution: `${src.width}x${src.height}`,
    codec: src.codec,
    page_url: `https://www.douyin.com/video/${a.aweme_id}`,
    cover: a.video?.cover?.url_list?.[0],
    is_image_post: Boolean(a.images?.length), // 图文
  };
}

// 流式写盘（长视频可能上 GB），先写 .part，完整后再改名，避免留下半截文件
async function download(a, ua) {
  const file = path.join(outDir, `${a.aweme_id}.mp4`);
  if (fs.existsSync(file)) return { file, skipped: true };
  const part = file + '.part';
  for (const url of pickSource(a).urls) {
    try {
      const res = await fetch(url, { headers: { Referer: 'https://www.douyin.com/', 'User-Agent': ua } });
      if (!res.ok || !res.body) continue;
      const total = Number(res.headers.get('content-length')) || 0;
      let got = 0, lastLog = Date.now();
      await pipeline(Readable.fromWeb(res.body).on('data', chunk => {
        got += chunk.length;
        if (total && Date.now() - lastLog > 5000) {
          lastLog = Date.now();
          console.log(`  ${a.aweme_id} ${(got / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)}MB`);
        }
      }), fs.createWriteStream(part));
      if (got < 10000 || (total && got !== total)) { fs.rmSync(part, { force: true }); continue; }
      fs.renameSync(part, file);
      return { file, size: got };
    } catch {
      fs.rmSync(part, { force: true });
    }
  }
  throw new Error('所有直链都下载失败（链接有时效，需重新抓取）');
}

// 从 ID / 网页链接 / 分享文案（含 v.douyin.com 短链）里解析 aweme_id
async function resolveId(input, ua) {
  if (/^\d{15,}$/.test(input)) return input;
  const direct = input.match(/(?:video\/|modal_id=|note\/)(\d{15,})/);
  if (direct) return direct[1];
  const short = input.match(/https?:\/\/v\.douyin\.com\/[\w-]+\/?/);
  if (short) {
    const res = await fetch(short[0], { redirect: 'manual', headers: { 'User-Agent': ua } });
    const m = (res.headers.get('location') || '').match(/(?:video|note)\/(\d{15,})/);
    if (m) return m[1];
  }
  throw new Error(`无法从输入中解析视频 ID: ${input}`);
}

// ---------- 模式 ----------
async function listPage(b, url, urlFilter, label) {
  console.log('打开', url);
  await b.goto(url);
  const waitSec = headful ? 180 : 20;
  if (headful) console.log(`如出现验证码或登录框，请在 Chrome 窗口里手动完成（最多等 ${waitSec}s）`);
  for (let i = 0; i < waitSec && collect(b.responses, urlFilter).size === 0; i++) await sleep(1000);
  for (let i = 0; i < 8 && collect(b.responses, urlFilter).size < limit; i++) {
    await b.scroll();
    await sleep(2500);
  }
  const map = collect(b.responses, urlFilter);
  if (!map.size) {
    await b.screenshot(path.join(outDir, `${label}_page.png`));
    console.log(`未拿到数据。页面标题: ${await b.title()}，截图: ${path.join(outDir, `${label}_page.png`)}`);
    if (!headful) console.log('多半是验证码，加 --headful 手动过一次验证/扫码登录后再试。');
  }
  return [...map.values()].slice(0, limit);
}

async function fetchDetail(b, id) {
  b.responses.length = 0;
  await b.goto(`https://www.douyin.com/video/${id}`);
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const hit = collect(b.responses, u => u.includes('/aweme/detail')).get(id);
    if (hit) return hit;
  }
  throw new Error(`视频 ${id} 未拿到详情（页面标题: ${await b.title()}）`);
}

const b = await openBrowser();
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
try {
  let awemes = [];
  if (mode === 'video') {
    if (!positional.length) throw new Error('用法: node.exe douyin.mjs video <ID|链接|分享文案> ...');
    for (const input of positional) {
      try {
        awemes.push(await fetchDetail(b, await resolveId(input, b.ua)));
      } catch (e) { console.error('✗', e.message); }
    }
  } else if (mode === 'feed') {
    awemes = await listPage(b, 'https://www.douyin.com/?recommend=1', u => u.includes('/module/feed'), 'feed');
  } else if (mode === 'search') {
    const kw = positional.join(' ');
    if (!kw) throw new Error('用法: node.exe douyin.mjs search <关键词>');
    awemes = await listPage(b, `https://www.douyin.com/search/${encodeURIComponent(kw)}?type=video`,
      u => /\/search\//.test(u), 'search');
  } else {
    throw new Error('模式: video | feed | search');
  }

  const items = awemes.map(summarize);
  if (items.length) {
    const jsonFile = path.join(outDir, `${mode}_${stamp}.json`);
    fs.writeFileSync(jsonFile, JSON.stringify(items, null, 2));
    console.log(`\n共 ${items.length} 条，详情: ${jsonFile}`);
  }
  items.forEach((v, i) => console.log(
    `${String(i + 1).padStart(2)}. [${v.author}] ${(v.desc || '').replace(/\s+/g, ' ').slice(0, 36)}` +
    `  ${v.duration_s}s ${v.resolution} 👍${v.likes}${v.is_image_post ? ' (图文)' : ''}  ${v.aweme_id}`));

  const toGet = awemes.filter(a => !a.images?.length).slice(0, downloadN);
  for (const a of toGet) {
    try {
      const r = await download(a, b.ua);
      console.log(r.skipped ? `已存在 ${r.file}` : `↓ ${(r.size / 1048576).toFixed(1)}MB  ${r.file}`);
    } catch (e) { console.error(`✗ ${a.aweme_id}: ${e.message}`); }
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  b.close();
  setTimeout(() => process.exit(), 300);
}
