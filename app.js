/**
 * 地震情報モニター - フロントエンド
 * Cloudflare Worker 経由で気象庁公開XMLを取得・表示
 */

(function () {
  "use strict";

  // ===== 設定 =====
  // デプロイ後は Worker の URL に変更してください
  // 例: "https://earthquake-monitor.YOUR_SUBDOMAIN.workers.dev"
  const API_BASE = ""; // 相対パス（同一ドメイン想定）またはフルURL
  const API_ENDPOINT = API_BASE + "/api/earthquakes";
  const POLL_INTERVAL_MS = 60 * 1000; // 1分ごと（試作版。必要に応じて調整）

  // 都道府県リスト（JIS順・表示用）
  const PREFECTURES = [
    { code: "01", name: "北海道" },
    { code: "02", name: "青森県" },
    { code: "03", name: "岩手県" },
    { code: "04", name: "宮城県" },
    { code: "05", name: "秋田県" },
    { code: "06", name: "山形県" },
    { code: "07", name: "福島県" },
    { code: "08", name: "茨城県" },
    { code: "09", name: "栃木県" },
    { code: "10", name: "群馬県" },
    { code: "11", name: "埼玉県" },
    { code: "12", name: "千葉県" },
    { code: "13", name: "東京都" },
    { code: "14", name: "神奈川県" },
    { code: "15", name: "新潟県" },
    { code: "16", name: "富山県" },
    { code: "17", name: "石川県" },
    { code: "18", name: "福井県" },
    { code: "19", name: "山梨県" },
    { code: "20", name: "長野県" },
    { code: "21", name: "岐阜県" },
    { code: "22", name: "静岡県" },
    { code: "23", name: "愛知県" },
    { code: "24", name: "三重県" },
    { code: "25", name: "滋賀県" },
    { code: "26", name: "京都府" },
    { code: "27", name: "大阪府" },
    { code: "28", name: "兵庫県" },
    { code: "29", name: "奈良県" },
    { code: "30", name: "和歌山県" },
    { code: "31", name: "鳥取県" },
    { code: "32", name: "島根県" },
    { code: "33", name: "岡山県" },
    { code: "34", name: "広島県" },
    { code: "35", name: "山口県" },
    { code: "36", name: "徳島県" },
    { code: "37", name: "香川県" },
    { code: "38", name: "愛媛県" },
    { code: "39", name: "高知県" },
    { code: "40", name: "福岡県" },
    { code: "41", name: "佐賀県" },
    { code: "42", name: "長崎県" },
    { code: "43", name: "熊本県" },
    { code: "44", name: "大分県" },
    { code: "45", name: "宮崎県" },
    { code: "46", name: "鹿児島県" },
    { code: "47", name: "沖縄県" }
  ];

  // ===== 状態 =====
  let earthquakes = [];
  let selectedPrefs = new Set(PREFECTURES.map((p) => p.name)); // 初期は全国
  let pollTimer = null;
  let isLoading = false;

  // ===== DOM =====
  const $list = document.getElementById("earthquake-list");
  const $status = document.getElementById("status-area");
  const $lastUpdated = document.getElementById("last-updated");
  const $prefFilters = document.getElementById("prefecture-filters");
  const $btnRefresh = document.getElementById("btn-refresh");
  const $btnSelectAll = document.getElementById("btn-select-all");
  const $btnClearAll = document.getElementById("btn-clear-all");
  const $btnTraining = document.getElementById("btn-training");
  const $trainingOverlay = document.getElementById("training-overlay");
  const $btnCloseTraining = document.getElementById("btn-close-training");

  // ===== 初期化 =====
  function init() {
    renderPrefectureFilters();
    bindEvents();
    fetchEarthquakes();
    startPolling();
  }

  function bindEvents() {
    $btnRefresh.addEventListener("click", () => fetchEarthquakes(true));
    $btnSelectAll.addEventListener("click", selectAllPrefs);
    $btnClearAll.addEventListener("click", clearAllPrefs);
    $btnTraining.addEventListener("click", showTraining);
    $btnCloseTraining.addEventListener("click", hideTraining);

    // Esc で訓練画面を閉じる
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$trainingOverlay.hidden) {
        hideTraining();
      }
    });
  }

  // ===== 都道府県フィルター =====
  function renderPrefectureFilters() {
    $prefFilters.innerHTML = "";
    PREFECTURES.forEach((pref) => {
      const label = document.createElement("label");
      label.className = "pref-checkbox";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = pref.name;
      cb.checked = selectedPrefs.has(pref.name);
      cb.addEventListener("change", () => {
        if (cb.checked) {
          selectedPrefs.add(pref.name);
        } else {
          selectedPrefs.delete(pref.name);
        }
        renderList();
      });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(pref.name));
      $prefFilters.appendChild(label);
    });
  }

  function selectAllPrefs() {
    selectedPrefs = new Set(PREFECTURES.map((p) => p.name));
    $prefFilters.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.checked = true;
    });
    renderList();
  }

  function clearAllPrefs() {
    selectedPrefs.clear();
    $prefFilters.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.checked = false;
    });
    renderList();
  }

  // ===== データ取得 =====
  async function fetchEarthquakes(manual = false) {
    if (isLoading) return;
    isLoading = true;
    $btnRefresh.disabled = true;
    if (manual) {
      setStatus("更新中...", "info");
    }

    try {
      const res = await fetch(API_ENDPOINT, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store"
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
      }

      const data = await res.json();

      if (!data || !Array.isArray(data.earthquakes)) {
        throw new Error("レスポンス形式が不正です");
      }

      earthquakes = data.earthquakes;
      const updatedAt = data.updatedAt || new Date().toISOString();
      $lastUpdated.textContent = "最終更新: " + formatDateTime(updatedAt);
      setStatus(
        `取得成功（${earthquakes.length}件）`,
        "success"
      );
      // 成功メッセージは数秒で消す
      setTimeout(() => {
        if ($status.querySelector(".status-success")) {
          $status.innerHTML = "";
        }
      }, 3000);
      renderList();
    } catch (err) {
      console.error(err);
      setStatus(
        "情報の取得に失敗しました。しばらくしてから再度お試しください。\n" +
          (err.message || String(err)),
        "error"
      );
      if (earthquakes.length === 0) {
        $list.innerHTML =
          '<p class="empty-message">データを表示できませんでした。</p>';
      }
    } finally {
      isLoading = false;
      $btnRefresh.disabled = false;
    }
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => fetchEarthquakes(false), POLL_INTERVAL_MS);
  }

  // ===== 表示 =====
  function renderList() {
    const filtered = earthquakes.filter((eq) => {
      // 選択された都道府県のいずれかで震度が観測されているか
      // または震源地の都道府県名が含まれるか
      if (selectedPrefs.size === 0) return false;
      if (selectedPrefs.size === PREFECTURES.length) return true; // 全国

      const prefs = eq.prefectures || [];
      const hit = prefs.some((p) => selectedPrefs.has(p.name));
      if (hit) return true;

      // 震源地名に都道府県名が含まれる場合も表示（例: 「千葉県東方沖」）
      const epi = eq.epicenter || "";
      return Array.from(selectedPrefs).some((name) => epi.includes(name.replace("県", "").replace("府", "").replace("都", "")));
    });

    if (filtered.length === 0) {
      $list.innerHTML =
        '<p class="empty-message">表示対象の地震情報がありません。<br>フィルターを確認するか、情報を更新してください。</p>';
      return;
    }

    $list.innerHTML = filtered
      .map((eq) => {
        const maxInt = eq.maxIntensity || "-";
        const intNum = normalizeIntensity(maxInt);
        const prefsText =
          (eq.prefectures || [])
            .map((p) => `${p.name}（${p.maxIntensity || "-"}）`)
            .join("、") || "-";

        return `
          <article class="eq-card">
            <div class="eq-card-header">
              <time class="eq-time" datetime="${escapeAttr(eq.originTime || "")}">${escapeHtml(formatDateTime(eq.originTime))}</time>
              <span class="eq-intensity" data-int="${intNum}">最大震度 ${escapeHtml(String(maxInt))}</span>
            </div>
            <div class="eq-body">
              <p class="eq-epicenter">震源地: ${escapeHtml(eq.epicenter || "不明")}</p>
              <div class="eq-meta">
                <span>マグニチュード: <strong>${escapeHtml(eq.magnitude != null ? String(eq.magnitude) : "不明")}</strong></span>
                <span>深さ: ${escapeHtml(eq.depth || "不明")}</span>
              </div>
              <p class="eq-prefs">観測都道府県: ${escapeHtml(prefsText)}</p>
            </div>
          </article>
        `;
      })
      .join("");
  }

  function normalizeIntensity(val) {
    if (val == null) return "0";
    const s = String(val);
    if (s.includes("7")) return "7";
    if (s.includes("6")) return "6";
    if (s.includes("5")) return "5";
    if (s.includes("4")) return "4";
    if (s.includes("3")) return "3";
    if (s.includes("2")) return "2";
    if (s.includes("1")) return "1";
    return "0";
  }

  // ===== 訓練表示（実際のEEWと完全分離） =====
  function showTraining() {
    $trainingOverlay.hidden = false;
    $trainingOverlay.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }

  function hideTraining() {
    $trainingOverlay.hidden = true;
    $trainingOverlay.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }

  // ===== ユーティリティ =====
  function setStatus(message, type) {
    const cls =
      type === "error"
        ? "status-error"
        : type === "success"
          ? "status-success"
          : "status-info";
    $status.innerHTML = `<div class="status-message ${cls}">${escapeHtml(message).replace(/\n/g, "<br>")}</div>`;
  }

  function formatDateTime(iso) {
    if (!iso) return "--";
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      const h = String(d.getHours()).padStart(2, "0");
      const min = String(d.getMinutes()).padStart(2, "0");
      return `${y}/${m}/${day} ${h}:${min}`;
    } catch {
      return iso;
    }
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttr(str) {
    return escapeHtml(str).replace(/\n/g, " ");
  }

  // 起動
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
