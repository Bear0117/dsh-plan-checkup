# M2 評測

用合成的計畫比較判斷引擎。題目、state 和合成規則都走插件本身的 `runCheckup`，量到的就是產品實際的行為。

## 檔案

| 檔案 | 內容 |
|---|---|
| `LABELS.md` | 標註準則與刻意放進去的陷阱 |
| `scenarios.js` | 14 個情境與共用步驟庫，每一步附標準答案，繁中、簡中、英文三種寫法 |
| `generate.mjs` | 用固定的 seed 組出計畫，寫到 `data/plans.jsonl` |
| `configs.js` | 要比較的引擎設定 |
| `run.mjs` | 用一種設定跑完整份資料，寫到 `runs/<名稱>.jsonl`，中斷後可以接著跑 |
| `report.mjs` | 對答案、算指標，寫到 `results/summary.json`；也用記錄下來的機率重算不同門檻下的標記 |
| `tables.mjs`、`build-report.mjs`、`report.src.html` | 由 `summary.json` 產生報告的表格，再組成 `../dsh-plan-checkup-m2-report.html` |

兩份資料：`data/plans.jsonl` 是開發集（14 個情境，用來改題目和挑門檻），`data/test.jsonl` 是保留測試集（6 個第一輪之後才寫的情境，只拿來驗證）。名稱以 `test-` 開頭的執行結果用保留測試集計分，`v1-` 開頭的是第一版題目的結果。

## 重跑

```bash
node eval/generate.mjs                       # 開發集：210 份計畫，1,001 步
node eval/generate.mjs --split test          # 保留測試集：90 份計畫，414 步
node eval/run.mjs rules                      # 只用規則的底線
node eval/run.mjs rules --plans eval/data/test.jsonl --run test-rules

# 區網或本機的 OpenAI 相容端點（要回傳 logprobs）
export EVAL_LLM_ENDPOINT=http://<host>:<port>/v1/chat/completions
node eval/run.mjs qwen-en
node eval/run.mjs qwen-zh
node eval/run.mjs qwen-en-swap
node eval/run.mjs qwen-en --limit 60 --run qwen-en-r2   # 重跑，量變異

# Laya：先在本機啟動伺服器（見下方）
node eval/run.mjs laya-auto
node eval/run.mjs laya-multilingual
node eval/run.mjs laya-typed

# 保留測試集：同樣的設定加上 --plans 與 test- 開頭的名稱
node eval/run.mjs qwen-en --plans eval/data/test.jsonl --run test-qwen-en

node eval/report.mjs
node eval/tables.mjs && node eval/build-report.mjs
```

## Laya 伺服器

```bash
py -3.14 -m venv .venv
.venv/Scripts/python.exe -m pip install torch==2.14.0 --index-url https://download.pytorch.org/whl/cu130
.venv/Scripts/python.exe -m pip install "laya[serve]==0.3.22"
LAYA_HOST=127.0.0.1 LAYA_PORT=8791 LAYA_DEVICE=cuda LAYA_MODELS=english,multilingual,typed-decisions LAYA_MAX_LOADED=3 .venv/Scripts/laya-serve.exe
```

`LAYA_HOST` 一定要設：預設會綁在 `0.0.0.0`，整個網路都連得到。

## 注意

- 這是合成資料：每個情境的步驟會在不同計畫裡重複出現，實際上不同的步驟文字約 600 段，指標的有效樣本數比步驟數少。
- 最佳門檻和擬合的溫度是在同一份資料上算的，只能當校準的起點，要用另一份資料確認。
- 標準答案是依 `LABELS.md` 構造的，判斷不了的標成 `null`，不計分。
