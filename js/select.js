// 「選んで削除」(まとめて削除)の画面側で使う、決まりごとの計算(純粋な処理。テストあり)。

// 選択の切り替え。元の Set は変えず、新しい Set を返す。
export function toggleSelected(selected, id) {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

// 「N件を削除」ボタンの文字と、押せるかどうか(0件なら押せない)。
export function bulkDeleteButtonState(count) {
  return { text: `${count}件を削除`, disabled: count < 1 };
}

// 確認ダイアログの文。target は 'note' か 'memo'。
export function bulkConfirmMessage(target, count) {
  if (target === 'note') {
    return `選んだ${count}件のノートを削除します。\nノートの中のメモと写真もすべて消え、元に戻せません。\nよろしいですか?`;
  }
  return `選んだ${count}件のメモを削除します。\n写真がある場合も一緒に消え、元に戻せません。\nよろしいですか?`;
}

// 削除する id の一覧を整える(重複と空を除く。順番は保つ)。
export function normalizeIds(ids) {
  return [...new Set((ids || []).filter((id) => typeof id === 'string' && id !== ''))];
}
