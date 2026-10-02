// 写真の読み込み・縮小・向き補正。
// 長辺1600pxを超える写真だけ縮小し、JPEG(品質0.8)にして返す。ネットワークには何も送らない。

export const MAX_EDGE = 1600;
export const JPEG_QUALITY = 0.8;

// 縮小後の大きさを計算する(純粋な処理。テストあり)。
// 長辺が max 以下ならそのまま。超えるときは縦横比を保って長辺を max にそろえる。
export function calcScaledSize(width, height, max = MAX_EDGE) {
  if (!(width > 0 && height > 0)) throw new Error('画像の大きさが不正です');
  const longEdge = Math.max(width, height);
  if (longEdge <= max) return { width, height };
  const ratio = max / longEdge;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

// 画像を読み込む。向き情報(EXIF)を反映した状態で受け取る。
// まず createImageBitmap を試し、だめなら <img> + Object URL で読み込む。
async function loadImage(file) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close(), // 使い終わったらメモリを返す
    };
  } catch (err) {
    // 下の方法へ
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('写真を読み込めませんでした'));
      img.src = url;
    });
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

// 写真ファイル1枚を、縮小済みの JPEG(Blob)にして返す。
export async function shrinkToJpeg(file) {
  const image = await loadImage(file);
  try {
    const { width, height } = calcScaledSize(image.width, image.height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    // 透明な部分が黒くならないよう、先に白で塗る
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image.source, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    canvas.width = 0; // 画像用メモリを早めに手放す
    canvas.height = 0;
    if (!blob) throw new Error('写真を変換できませんでした');
    return blob;
  } finally {
    image.release();
  }
}
