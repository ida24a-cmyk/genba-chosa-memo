// 時刻の扱いと、メモの並び順をまとめたファイル。
// ここにある関数はブラウザの機能に頼らない「純粋な処理」なので、Node でもテストできる。
//
// 時刻はすべて「記録したときの端末の現地時刻」を、タイムゾーン表記なしの文字列で持つ。
//   保存用:  YYYY-MM-DDTHH:MM:SS.mmm   (例 2026-10-02T10:32:05.123)
//   観測時刻: YYYY-MM-DDTHH:MM          (分まで。datetime-local の入力値と同じ形)
// UTC には変換しない(移動して時差があっても、過去の時刻が変わらないようにするため)。

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

// Date の「現地時刻」の部品から、保存用の文字列を作る。
export function formatLocalTimestamp(date = new Date()) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}`
  );
}

// 観測時刻の入力欄(datetime-local)に入れる、分までの文字列を作る。
export function formatObservedInput(date = new Date()) {
  return formatLocalTimestamp(date).slice(0, 16);
}

// 比べるために、観測時刻の秒以下を「:00.000」にそろえる。
// 形式が合わない文字列は null を返す。
export function normalizeObserved(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::\d{2}(?:\.\d{1,3})?)?$/.exec(value);
  return m ? `${m[1]}:00.000` : null;
}

// 画面表示・書き出し用: YYYY-MM-DD HH:MM
export function formatDisplay(value) {
  if (typeof value !== 'string' || value.length < 16) return '';
  return `${value.slice(0, 10)} ${value.slice(11, 16)}`;
}

// ファイル名用: YYYYMMDD-HHMM
export function formatFileStamp(value) {
  if (typeof value !== 'string' || value.length < 16) return '';
  return `${value.slice(0, 4)}${value.slice(5, 7)}${value.slice(8, 10)}-${value.slice(11, 13)}${value.slice(14, 16)}`;
}

// id の末尾の数字を取り出す(例 'm-000012' → 12)。数字がなければ 0。
function idNumber(id) {
  const m = /(\d+)$/.exec(String(id));
  return m ? Number(m[1]) : 0;
}

// メモを並べる比較関数: 観測時刻 → 記録時刻 → メモid の昇順。
function compareMemos(a, b) {
  const ao = normalizeObserved(a.observedAt) ?? '';
  const bo = normalizeObserved(b.observedAt) ?? '';
  if (ao !== bo) return ao < bo ? -1 : 1;
  const ar = a.recordedAt ?? '';
  const br = b.recordedAt ?? '';
  if (ar !== br) return ar < br ? -1 : 1;
  return idNumber(a.id) - idNumber(b.id);
}

// メモの並べ替え(元の配列は変えず、新しい配列を返す)。
// アプリの一覧・mdファイルの書き出し・写真の連番は、すべてこの関数を使うこと。
export function sortMemos(memos) {
  return [...memos].sort(compareMemos);
}
