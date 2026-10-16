// 版ごとの設定を1か所にまとめたファイル(第9章)。
// 入り口のHTMLの <html data-edition="..."> を読んで、どちらの版かを決める。
// 調査メモの DB名と番号の頭文字は、これまでのデータをそのまま使うため絶対に変えないこと。

export const EDITIONS = {
  // 調査メモ(元の版)
  chosa: {
    key: 'chosa',
    label: '調査メモ',
    dbName: 'genba-chosa-memo',
    idPrefix: 'inv',
    kindChoice: true, // 作成画面で「調査/ふつう」を選ばせる
  },
  // 写真メモ(一般向け)。記録の保存場所は調査メモと別。
  shashin: {
    key: 'shashin',
    label: '写真メモ',
    dbName: 'genba-shashin-memo',
    idPrefix: 'note',
    kindChoice: false, // 種類は常に「ふつう」
  },
};

// 版の名前(data-edition の値)から設定を返す。知らない値・未指定は調査メモ(元の版)。
export function editionFor(key) {
  return Object.prototype.hasOwnProperty.call(EDITIONS, key) ? EDITIONS[key] : EDITIONS.chosa;
}

// いまのページの版。ブラウザ以外(テスト)では調査メモ。
export function currentEdition() {
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  return editionFor(root && root.dataset ? root.dataset.edition : undefined);
}
