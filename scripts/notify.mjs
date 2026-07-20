// data/ 内の最新JSONを読み、Webページと同じロジックで「メイン睡眠」を算出し、
// LINEにブロードキャスト送信する。GitHub Actions から実行される。
// 判定ロジック（SESSION_GAP / MAIN_MIN / ステージ集計）は docs/index.html と一致させること。
import { readFileSync, readdirSync } from "node:fs";

const TOKEN = process.env.LINE_TOKEN;
const WEB_URL = "https://khoshino-bot.github.io/sleep-log/";
const SESSION_GAP = 120; // 分。これ以上の空きは別セッション
const MAIN_MIN = 180;    // 分。これ以上を本睡眠とみなす（昼寝除外）
const STAGE_MAP = { "深い": "deep", "コア": "core", "レム": "rem", "覚醒": "awake", deep: "deep", core: "core", rem: "rem", awake: "awake" };

function durToSec(str) {
  const p = String(str || "").trim().split(":").map((x) => Number(x) || 0);
  if (p.length === 1) return p[0];
  if (p.length === 2) return p[0] * 60 + p[1];
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  return 0;
}
function mapStage(s) { const k = String(s || "").trim(); return STAGE_MAP[k] || STAGE_MAP[k.toLowerCase()] || ""; }
// "yyyy-MM-dd HH:mm" → 絶対分（UTC計算で見た目の時刻を保持）
function parseAbs(s) {
  const m = String(s || "").trim().match(/(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000 : null;
}
function fmtDateTime(minAbs) {
  const d = new Date(Math.round(minAbs) * 60000);
  return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()} ${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function latestDataFile() {
  const dir = "data";
  const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  if (!files.length) return null;
  return `${dir}/${files[files.length - 1]}`;
}

// 生データ → メイン睡眠のステージ集計・就寝/起床。データ無しなら null。
function computeMain(raw) {
  const st = String(raw.stagesCSV || "").split(",");
  const sc = String(raw.secsCSV || "").split(",");
  const stc = raw.startsCSV != null ? String(raw.startsCSV).split(",") : [];
  let items = st.map((s, i) => ({ stage: mapStage(s), min: durToSec(sc[i]) / 60, abs: stc.length ? parseAbs(stc[i]) : null }))
    .filter((x) => x.stage && x.min > 0);
  if (!items.length) return null;

  if (items.every((x) => x.abs != null)) {
    items.sort((a, b) => a.abs - b.abs);
    const sessions = []; let cur = [items[0]];
    for (let i = 1; i < items.length; i++) {
      if (items[i].abs - (items[i - 1].abs + items[i - 1].min) > SESSION_GAP) { sessions.push(cur); cur = [items[i]]; }
      else cur.push(items[i]);
    }
    sessions.push(cur);
    const asleepMin = (s) => s.reduce((a, x) => a + (x.stage === "awake" ? 0 : x.min), 0);
    let main = null;
    for (const s of sessions) { if (asleepMin(s) >= MAIN_MIN) main = s; }
    if (!main) main = sessions.reduce((best, s) => (asleepMin(s) > asleepMin(best) ? s : best));
    items = main;
  }

  const tot = { deep: 0, core: 0, rem: 0, awake: 0 };
  items.forEach((x) => { tot[x.stage] = (tot[x.stage] || 0) + x.min; });
  const stages = { deep: Math.round(tot.deep), core: Math.round(tot.core), rem: Math.round(tot.rem), awake: Math.round(tot.awake) };
  const asleep = stages.deep + stages.core + stages.rem;
  const hasAbs = items[0].abs != null;
  const bedAbs = hasAbs ? items[0].abs : null;
  const wakeAbs = hasAbs ? items[items.length - 1].abs + items[items.length - 1].min : null;
  return { stages, asleep, bedAbs, wakeAbs };
}

function hm(min) { const h = Math.floor(min / 60), m = Math.round(min % 60); return `${h}時間${m}分`; }

function buildText(m) {
  if (!m) {
    return "おはようクソバカ🖐️\n昨日Apple Watch付け忘れたでしょ？データ無いんだけど。\nちゃんと着けて寝ろ。";
  }
  const lines = ["おはようクソバカ🖐️ 今日も頑張ろうね😉", ""];
  if (m.bedAbs != null) { lines.push(`就寝 ${fmtDateTime(m.bedAbs)}`); lines.push(`起床 ${fmtDateTime(m.wakeAbs)}`); }
  lines.push(`☀️合計睡眠時間 ${hm(m.asleep)}`);
  lines.push("");
  lines.push(`深い ${m.stages.deep}分 / コア ${m.stages.core}分 / レム ${m.stages.rem}分 / 覚醒 ${m.stages.awake}分`);
  lines.push("");
  lines.push(`睡眠ログ ${WEB_URL}`);
  return lines.join("\n");
}

async function sendLine(text) {
  if (!TOKEN) throw new Error("LINE_TOKEN が設定されていません");
  const res = await fetch("https://api.line.me/v2/bot/message/broadcast", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ messages: [{ type: "text", text }] }),
  });
  if (!res.ok) throw new Error(`LINE送信失敗 ${res.status}: ${await res.text()}`);
}

const file = latestDataFile();
if (!file) { console.error("data/ にJSONがありません"); process.exit(0); }
const raw = JSON.parse(readFileSync(file, "utf8"));
const main = computeMain(raw);
const text = buildText(main);
console.log(`file=${file}\n---\n${text}\n---`);
if (process.env.DRY_RUN) { console.log("(DRY_RUN: 送信スキップ)"); process.exit(0); }
await sendLine(text);
console.log("LINE送信 完了");
