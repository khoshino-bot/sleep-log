// 今日(JST)の睡眠JSONを読み、Webページと同じロジックで「メイン睡眠」を算出しLINE送信する。
// トリガー：push(data/**) / schedule(10:05 JST cron) / workflow_dispatch。
// 朝のpushは上書きのみ→10:05 cronが最新を送信。昼(LATE_HOUR)以降のpushは初回送信可。
// 二度寝で伸びたら補正1通。state/ に送信済み量を記録して重複防止。
// 判定ロジック(SESSION_GAP/MAIN_MIN/ステージ集計)は docs/index.html と一致させること。
import { readFileSync, existsSync } from "node:fs";
import { Buffer } from "node:buffer";

const TOKEN = process.env.LINE_TOKEN;
const GH_TOKEN = process.env.GH_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY || "khoshino-bot/sleep-log";
const EVENT = process.env.GITHUB_EVENT_NAME || "";
const WEB_URL = "https://khoshino-bot.github.io/sleep-log/";
const SESSION_GAP = 120;    // 分。これ以上の空きは別セッション
const MAIN_MIN = 180;       // 分。これ以上を本睡眠とみなす（昼寝除外）
const CORRECTION_MIN = 60;  // 分。10時速報よりこれ以上増えたら補正LINEを送る
const OVERSLEEP_MIN = 540;  // 分。9時間以上なら「めっちゃ寝たな」ヘッダー
const LATE_HOUR = 11;       // 時(JST)。朝のpushは上書きのみ（送信はcronに一本化）。これ以降のpushは初回送信も可
const FRESH_HOURS = 20;     // 時間。本睡眠の起床がこれ以上前なら「昨夜のものではない＝古い」とみなす
const STAGE_MAP = { "深い": "deep", "コア": "core", "レム": "rem", "覚醒": "awake", deep: "deep", core: "core", rem: "rem", awake: "awake" };

const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000);
const jstToday = () => { const d = jstNow(); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`; };
const jstHour = () => jstNow().getUTCHours();

function durToSec(str) {
  const p = String(str || "").trim().split(":").map((x) => Number(x) || 0);
  if (p.length === 1) return p[0];
  if (p.length === 2) return p[0] * 60 + p[1];
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  return 0;
}
const mapStage = (s) => { const k = String(s || "").trim(); return STAGE_MAP[k] || STAGE_MAP[k.toLowerCase()] || ""; };
function parseAbs(s) {
  const m = String(s || "").trim().match(/(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000 : null;
}
function fmtDateTime(minAbs) {
  const d = new Date(Math.round(minAbs) * 60000);
  return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()} ${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
const hm = (min) => `${Math.floor(min / 60)}時間${Math.round(min % 60)}分`;

// 生データ → メイン睡眠。データ無しなら null。
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
  return { stages, asleep, bedAbs: hasAbs ? items[0].abs : null, wakeAbs: hasAbs ? items[items.length - 1].abs + items[items.length - 1].min : null };
}

function loadToday() {
  const date = jstToday();
  const file = `data/${date}.json`;
  if (!existsSync(file)) return { status: "nodata", date };
  const main = computeMain(JSON.parse(readFileSync(file, "utf8")));
  if (!main || main.asleep <= 0) return { status: "empty", date };
  // 鮮度チェック：本睡眠の起床が古すぎる（昨夜のものでない）＝実質データ無し扱い
  if (main.wakeAbs != null) {
    const jstNowMin = Math.floor((Date.now() + 9 * 3600 * 1000) / 60000);
    if (jstNowMin - main.wakeAbs > FRESH_HOURS * 60) return { status: "stale", date, main };
  }
  return { status: "ok", date, main };
}

const ghHeaders = { Authorization: `Bearer ${GH_TOKEN}`, "User-Agent": "sleep-notify", Accept: "application/vnd.github+json" };
async function getState(date) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/state/notify-${date}.json`, { headers: ghHeaders });
  if (r.status === 404) return { sentAsleep: null, sha: null };
  if (!r.ok) throw new Error(`state GET ${r.status}`);
  const j = await r.json();
  return { sentAsleep: JSON.parse(Buffer.from(j.content, "base64").toString()).sentAsleep, sha: j.sha };
}
async function setState(date, sentAsleep, sha) {
  const body = { message: `chore: notify state ${date}`, content: Buffer.from(JSON.stringify({ sentAsleep })).toString("base64") };
  if (sha) body.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/state/notify-${date}.json`, { method: "PUT", headers: { ...ghHeaders, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`state PUT ${r.status}: ${await r.text()}`);
}

function buildText(main, oversleep) {
  const head = oversleep ? "おはようクソバカ🖐️ 今日はめっちゃ寝たな😴💤" : "おはようクソバカ🖐️ 今日も頑張ろうね😉";
  const lines = [head, ""];
  if (main.bedAbs != null) { lines.push(`就寝 ${fmtDateTime(main.bedAbs)}`); lines.push(`起床 ${fmtDateTime(main.wakeAbs)}`); }
  lines.push(`☀️合計睡眠時間 ${hm(main.asleep)}`);
  lines.push("");
  lines.push(`深い ${main.stages.deep}分 / コア ${main.stages.core}分 / レム ${main.stages.rem}分 / 覚醒 ${main.stages.awake}分`);
  lines.push("");
  lines.push(`睡眠ログ ${WEB_URL}`);
  return lines.join("\n");
}
const roastText = () => "おはようクソバカ🖐️\n昨日Apple Watch付け忘れたでしょ？データ無いんだけど。\nちゃんと着けて寝ろ。";

async function sendLine(text) {
  if (!TOKEN) throw new Error("LINE_TOKEN 未設定");
  const res = await fetch("https://api.line.me/v2/bot/message/broadcast", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ messages: [{ type: "text", text }] }),
  });
  if (!res.ok) throw new Error(`LINE送信失敗 ${res.status}: ${await res.text()}`);
}

// ---- main ----
const isCron = EVENT === "schedule" || EVENT === "workflow_dispatch";
const data = loadToday();
console.log(`event=${EVENT} isCron=${isCron} date=${data.date} status=${data.status} asleep=${data.main?.asleep ?? "-"}`);

if (process.env.DRY_RUN) {
  if (data.status === "ok") console.log("---\n" + buildText(data.main, data.main.asleep >= OVERSLEEP_MIN) + "\n---");
  else console.log(`(status=${data.status})`);
  process.exit(0);
}

if (data.status === "nodata") { console.log("今日のデータ未保存。送信なし"); process.exit(0); }

const st = await getState(data.date);

if (data.status === "empty" || data.status === "stale") {
  if (st.sentAsleep === null) { await sendLine(roastText()); await setState(data.date, -1, st.sha); console.log("叱りLINE送信"); }
  else console.log("処理済み。送信なし");
  process.exit(0);
}

const asleep = data.main.asleep;
if (st.sentAsleep === null) {
  if (isCron || jstHour() >= LATE_HOUR) {
    const over = asleep >= OVERSLEEP_MIN;
    await sendLine(buildText(data.main, over));
    await setState(data.date, asleep, st.sha);
    console.log(`初回送信 asleep=${asleep} over=${over}`);
  } else console.log(`朝のpush（上書きのみ・送信はcron担当）asleep=${asleep}`);
} else if (st.sentAsleep >= 0 && asleep > st.sentAsleep + CORRECTION_MIN) {
  await sendLine(buildText(data.main, true));
  await setState(data.date, asleep, st.sha);
  console.log(`補正送信 ${st.sentAsleep}→${asleep}`);
} else {
  console.log(`変化なし/送信済 sent=${st.sentAsleep} now=${asleep}`);
}
