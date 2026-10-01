# M0 驗證紀錄（2026-09-30）

在 dsh **0.2.0-rc.2**（npx 快取，Node 24.21.0，Windows 11）上，用獨立的 `DSH_HOME` 和本機假模型實測計畫體檢依賴的掛點。這一版外掛只記錄各掛點拿得到什麼，不呼叫 Jev。

## 結果

| # | 檢查項目 | 結果 | 證據 |
|---|---|---|---|
| 1 | 徽章出現在審閱卡片的工具列 | 通過 | 卡片頂端「查看全文」旁出現「體檢 M0：路由 OK」 |
| 2 | `review.callId` 等於 `exec.callId` | 通過 | 三次審閱 `call_m0_1`、`call_m0_4`、`call_m0_7`，瀏覽器用 callId 都查到主機端紀錄；`review.plan` 與 `exec.arguments.plan` 完全相同（`planMatches: true`），sessionId 也相同 |
| 3 | 徽章能帶著驗證呼叫自己的路由 | 通過 | 瀏覽器 `fetch('/plan-checkup/api/m0')` 回 200；curl 不帶驗證回 401，帶外部 Origin 回 403（都被 `connection.requestRejection` 擋下並記錄） |
| 4 | 審閱進行中 `inputActions.setDraft` 能不能寫入 | 通過 | 文字寫進輸入框的編輯器（審閱期間隱藏）；按「要求修改」後輸入框出現，內容就是寫入的回饋 |
| 5 | peer 範圍通過版本檢查 | 通過 | `>=0.1.7-0 <0.3.0` 正常載入；故意改成 `^0.1.5-rc.2` 時 dsh 印出 `skipping profile bundle "dsh-plan-checkup" … incompatible with dsh 0.2.0-rc.2`，整個 bundle 不載入 |

證據檔：`evidence-2026-09-30.jsonl`（外掛紀錄）、`evidence-badpeer-2026-09-30.log`（反向測試）、`evidence-mock-requests-2026-09-30.jsonl`（假模型收到的請求）。

## 會改變設計的發現

1. **`user-questions/request` 監聽器要加 `{ prepend: true }`。** Web 介面的回答者會自己回答、不呼叫 `next()`，排在內層的監聽器完全收不到。改成最外層後：
   - 看得到 `{questions, agent, signal}`，intent 是 `plan-review`，帶 callId；`detail` 等於 pre-execute 時的計畫。
   - 按「同意執行」時 `await next()` 回傳 `{"answers":[{"id":"plan-review","selected":["Approve"]}]}`。
   - 按「要求修改」時 `await next()` 丟出 `ASK_CANCELLED`（the user cancelled ask_user_question），照原樣再丟出去即可；模型收到「使用者關閉審閱改用文字回覆」。
2. **0.2.0 的審閱卡片按鈕是「要求修改」和「同意執行」**，不是原始碼 0.1.7 裡的「討論／核准」。「要求修改」走的是取消審閱，不是回答 Keep planning。回饋路線因此是：按「帶入輸入框」→ 按「要求修改」→ 輸入框帶著回饋文字 → 送出。
3. **細節面板不能在工具列裡用絕對定位。** 卡片會裁切超出範圍的內容，還把對話欄往旁邊推。M1 要改用 portal（掛到 `document.body`）或右側欄。
4. **取使用者需求一定要過濾 `source.kind === 'user'`。** 同一步裡還有兩則使用者角色訊息，來源分別是 `runtime-context` 和 `skill-catalog`。
5. **pre-execute 比審閱開啟早約 15 毫秒**，體檢可以在卡片出現前就開始跑。
6. **瀏覽器端可以手寫**，不需要打包：格式是 `window.__ModuleLoader__.load({ id, factory: (require) => … })`，React 用 `require("react")` 取得。M1 若要用 TSX 再引入打包工具。
7. `exec` 的欄位：`token, callId, rootCallId, name, signal, agent, deferContext, concludeTurn, arguments`；元件拿到的 props 包含 `review, requestKey, sessionId, inputActions, useInput, useProjection, useSession` 等。

## 怎麼重跑

```bash
# 1. 假模型（另開一個 shell）
node m0/mock-llm.mjs 18765 .m0/mock-requests.jsonl

# 2. 安裝到獨立的 web profile（只需一次；link 安裝，改檔後重啟即生效）
DSH_HOME=.m0/home npx -y @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add "link:$PWD"

# 3. 啟動 dsh web（不要用 3080，那是日常用的 dsh web）
cd .m0/workspace
DSH_HOME=../home DSH_TELEMETRY_MODE=DISABLED M0_MOCK_API_KEY=mock \
  npx -y @deepseek-ai/dsh@0.2.0-rc.2 web --patch ../../m0/overlay.yml --port 3190 --no-open
```

打開啟動時印出的 `http://127.0.0.1:3190/?token=…`，新建會話，輸入 `/plan` 後按 Enter，再輸入任意需求送出。假模型會交出固定的 7 步計畫，外掛紀錄寫在 `.m0/home/plan-checkup/m0.jsonl`。
