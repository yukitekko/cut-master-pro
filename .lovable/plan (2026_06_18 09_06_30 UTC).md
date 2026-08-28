「📄 PDFをダウンロード」ボタンを削除し、「🖨️ 印刷する」ボタンのみを残します。

変更ファイル: `src/routes/index.tsx`
- QuoteModal 下部の PDF ダウンロードボタンを削除
- `handleDownloadPdf` 関数と `html2pdf.js` の import を削除（ランタイムエラーの原因も解消）
- ボタンエリアを 1 カラムレイアウトに調整