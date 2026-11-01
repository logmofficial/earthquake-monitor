# 地震情報モニター（試作版）

気象庁が公開している防災情報XML（PULL型）を利用し、日本全国の地震情報を一覧表示するWebサイトの試作版です。

**本サイトは公式サービスではありません。避難判断や人命に関わる判断の唯一の情報源として使用しないでください。**

**気象庁の公開XMLは実際の緊急地震速報ではありません。緊急地震速報の受信には、気象庁または許可事業者との契約が必要です。**

## 機能

- 気象庁公開XMLから「震源・震度に関する情報」を取得・表示
- 発生日時・震源地・マグニチュード・最大震度・都道府県別震度の表示
- 定期的な自動更新（フロント側 約1分間隔）と手動更新
- 最終更新時刻の表示
- 47都道府県の複数選択フィルター（全国選択・解除対応）
- 取得失敗時のエラー表示
- **訓練用**緊急地震速報風の画面（必ず「訓練」「架空情報」と明記。実際のEEWとは完全分離）
- ヘルスチェック API（`/api/health`）

## 重要な制限事項

| 項目 | 内容 |
|------|------|
| データ源 | 気象庁 防災情報XML（PULL型）の公開フィードのみ |
| リアルタイム性 | 保証されません。フィード更新・取得タイミングに依存 |
| 緊急地震速報 | **受信できません**。実際のEEWは気象庁や許可事業者との契約が必要です |
| 用途 | 学習・試作・表示確認用。防災判断の唯一の根拠にしないこと |
| 利用量 | 1日10GB超のダウンロードでIP遮断される可能性あり（気象庁の留意事項） |

## 技術構成

- **フロント**: HTML / CSS / JavaScript（レスポンシブ）
- **バックエンド**: Cloudflare Workers（XML取得・パース・JSON返却）
- **キャッシュ**: Cloudflare Cache API（標準・約60秒）＋ KV（任意）
- **データ**:
  - 高頻度フィード: `https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml`
  - 長期フィード: `https://www.data.jma.go.jp/developer/xml/feed/eqvol_l.xml`
  - 対象電文例: VXSE53（震源・震度に関する情報）

## API

| パス | 説明 |
|------|------|
| `GET /api/earthquakes` | 地震情報一覧（JSON） |
| `GET /api/health` | 稼働確認（JSON） |

## ファイル構成

```
earthquake-monitor/
├── public/
│   ├── index.html    # メインページ
│   ├── style.css     # スタイル
│   └── app.js        # フロントエンドロジック
├── worker/
│   └── index.js      # Cloudflare Worker（API）
├── wrangler.toml     # Wrangler設定
├── package.json
└── README.md
```

## セットアップ手順

### 1. 前提

- Node.js 18 以上
- Cloudflare アカウント（無料プラン可）
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) CLI

### 2. インストール

```bash
cd earthquake-monitor
npm install
```

### 3. ローカル開発

```bash
npx wrangler dev
```

ブラウザで `http://localhost:8787` を開きます。  
`/api/earthquakes` と `/api/health` は Worker が処理し、静的ファイルは Assets から配信されます。

### 4. KV キャッシュ（任意）

Cache API が標準で動作するため必須ではありません。追加で使う場合:

```bash
npx wrangler kv namespace create EQ_CACHE
npx wrangler kv namespace create EQ_CACHE --preview
```

表示された ID を `wrangler.toml` の `[[kv_namespaces]]` に設定してください。

### 5. デプロイ

```bash
npx wrangler deploy
```

デプロイ後、Workers の URL（例: `https://earthquake-monitor.YOUR_SUBDOMAIN.workers.dev`）でアクセスできます。

フロントの `app.js` 内 `API_BASE` は同一オリジン想定のため、通常は変更不要です。

## 修正内容（v1.1）

- 詳細XML取得カウンターを「試行時」に増加（成功・失敗を問わず上限12件を厳守）
- 震央地名の抽出を VXSE53 構造に合わせて改善
- Pref ブロックを個別解析し、都道府県名・コード・最大震度を正しく対応
- 名前空間プレフィックス有無・CDATA・エスケープに対応したXML解析
- 高頻度・長期フィードの両方取得・重複排除・片方失敗時も継続
- HTTPタイムアウト設定
- Cache API を標準利用（約60秒）、KVは任意
- `/api/health` 追加
- Assets への適切な委譲

## ライセンス・利用上の注意

- 気象庁の公開XMLの利用にあたっては、[気象庁ホームページを通じて公開するXML形式電文のご利用にあたっての留意事項](https://xml.kishou.go.jp/considerationforxml.pdf) を必ず確認し、遵守してください。
- 本リポジトリのコードは試作・学習用です。商用利用や再配布の際は自己責任で行ってください。
- 本サービスは気象庁の公式サービスではありません。

## 参考リンク

- [気象庁 防災情報XML PULL型](https://xml.kishou.go.jp/xmlpull.html)
- [気象庁 防災情報ページ（地震）](https://www.jma.go.jp/bosai/map.html#contents=earthquake_map)
- [Cloudflare Workers ドキュメント](https://developers.cloudflare.com/workers/)
