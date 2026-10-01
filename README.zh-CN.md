# dsh-plan-checkup · 计划体检

[English](README.md) · 简体中文 · [繁體中文](README.zh-TW.md)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件。agent 在计划模式交出计划、你点「同意执行」之前，它会逐步检查每一步，把结果标在计划审阅卡片上。

| 标记 | 意思 | 判断方式 |
|---|---|---|
| 🔴 无法恢复 | 会删除或覆盖现有的数据、历史或资源 | 命令规则（`DROP TABLE`、`rm -rf`、`git push --force` 等）或判断引擎 |
| 🟠 影响工作区以外 | 会动到远程仓库、共享或生产环境、其他人，或付费服务 | 命令规则（`git push`、`npm publish`、`kubectl apply` 等）或判断引擎 |
| 🟡 需求没提到 | 需求没有要求的工作 | 判断引擎 |
| 🟡 描述太模糊 | 看不出要改什么、检查什么 | 判断引擎 |
| 🟡 没有验证步骤（整份计划） | 有步骤会改代码，但没有跑测试或构建 | 规则加判断引擎 |
| 🟡 可能漏了需求（整份计划） | 计划没有涵盖需求的所有部分 | 判断引擎 |

它只做提示，不会拦截、改写或替你批准计划。设置判断引擎之前，不会有任何内容离开你的电脑。

## 你会看到什么

1. 在 dsh web 输入 `/plan` 进入计划模式，再发送需求。
2. agent 交出计划后，审阅卡片的工具栏会出现「计划体检」徽章，在查看全文的链接旁边。规则命中的标记立刻出现；引擎检查期间，徽章显示进度（例如「体检中 3/8」），完成后显示各颜色标记的数量，或「没发现问题」。
3. 点击徽章查看细节：每个有标记的步骤、标记与概率、规则命中的命令，以及关于整份计划的提醒。每个标记旁有 👍 / 👎，你的投票会记在本机文件里，之后可以用来重新校准门槛。
4. 要让 agent 修改计划：先点「填入输入框」，再点卡片上的「要求修改」。输入框里会出现整理好的问题清单，确认或修改后发送即可。「复制反馈」会复制同样的文字。
5. 点「同意执行」就照常执行。

连不上判断引擎时，徽章显示「只用规则」，面板写明原因，审阅照常进行。

## 需求

- dsh 0.2.x。已在 dsh 0.2.0-rc.2（Windows 11、Node.js 24.21）的 web profile 上实测。
- Node.js 22.19 以上的 22 版，或 24 以上（与 dsh 相同）。
- 命令规则以外的检查需要判断引擎（见下一节）。

## 安装

```bash
dsh plugin --profile web add dsh-plan-checkup
```

如果你是用 npx 运行 dsh，改用 `npx @deepseek-ai/dsh plugin --profile web add dsh-plan-checkup`。装好后重启 `dsh web`。还没设置判断引擎时只跑命令规则，徽章会显示「只用规则」。

移除：运行 `dsh plugin --profile web remove dsh-plan-checkup`；如果你在 profile 的 `cordis.patch.yml` 加过 `plan-checkup` 段落，也一并删除。

## 设置判断引擎

设置写在 profile 的 `cordis.patch.yml`（web profile 是 `~/.dsh/profiles/web/cordis.patch.yml`）。`id: plan-checkup` 的段落会取代插件的整份 `config`，没写到的键使用默认值。

### 方式一：OpenAI 兼容端点（不需要 Jev 密钥）

每一题会转成带字母选项的选择题，模型只输出 1 个 token，插件从选项字母的 logprob 读出各选项的概率，不解析模型写的文字。端点要支持 `logprobs` 和 `top_logprobs`，例如 vLLM、SGLang、llama.cpp，或 Ollama 0.12.11 以上。

局域网里用 http 连接的 vLLM：

```yaml
- id: plan-checkup
  config:
    engine: llm
    llm:
      endpoint: http://10.0.0.20:8000/v1/chat/completions
      model: Qwen3.8-27B
      allowEgress: true            # 计划会发到这台主机
      allowHttpHosts: [10.0.0.20]  # 允许用 http 连接这台主机
      extraBody:
        chat_template_kwargs:
          enable_thinking: false   # 推理模型要关闭思考
```

本机端点（`127.0.0.1`、`localhost`）不需要 `allowEgress`。端点需要密钥时，把密钥存成 dsh 凭证或环境变量，再用 `llm.apiKeyEnv` 指定名称。

没关闭思考时，第一个 token 会是 `<think>` 而不是选项字母；这时体检会退回只用规则，面板会写明引擎的回应格式不对。

接上 dsh 之前，可以在这个仓库的副本里先测试端点：

```bash
npm run probe -- --endpoint http://10.0.0.20:8000/v1/chat/completions --model Qwen3.8-27B \
  --allow-egress --allow-http-host 10.0.0.20 --extra '{"chat_template_kwargs":{"enable_thinking":false}}'
```

它会用内置的 7 步计划（或 `--plan <文件>`）跑一次，印出每一步的概率和标记。

### 方式二：TypeSafe Jev，或 API 相同的服务

**TypeSafe 云端**：把密钥存成 `TYPESAFE_API_KEY`（dsh 凭证或环境变量），再打开外发：

```yaml
- id: plan-checkup
  config:
    jev:
      allowEgress: true
```

**与 Jev 兼容的服务**，例如 Laya、openjev：把端点指向它。本机服务不需要 `allowEgress`。

```yaml
- id: plan-checkup
  config:
    jev:
      endpoint: http://127.0.0.1:8791/v1/systemone
```

我们的评测里，预训练的 Laya 在这些题目上接近乱猜，请先用自己的数据微调再使用。默认门槛是依 Qwen3.8-27B 校准的，还没有对 Jev 核对过。

## 会发出去的数据

| 项目 | 内容 |
|---|---|
| 发送 | 你最近 3 条需求（最多 2,000 字）、计划标题、正在检查的这一步（最多 1,200 字），以及前后两步的第一行 |
| 不发送 | 仓库文件、工具输出、其他对话内容 |
| 发送前遮蔽 | API key 与 token（`sk-`、`ghp_`、`AKIA`、`apikey_` 等）、`Bearer …`、私钥区块、带账号密码的 URL、`password=` |
| 端点限制 | 本机端点不受限；其他端点要 `allowEgress: true`，而且要用 https，或列在 `allowHttpHosts` 里 |
| 请求数 | Jev 每一步 1 个请求；OpenAI 兼容端点每一题 1 个请求（7 步约 37 个，同一步的内容会随每一题重复发送） |
| 密钥 | 只放在 Authorization 头里，不写进记录，也不发到浏览器 |

## 设置

完整默认值在 [cordis.patch.yml](cordis.patch.yml)。常用的键：

| 键 | 默认 | 说明 |
|---|---|---|
| `engine` | `jev` | 判断引擎：`jev` 或 `llm` |
| `lang` | `auto` | 卡片与反馈文字的语言：`auto` 跟随 dsh 界面（简体中文或英文）；`zh-TW`、`zh-CN`、`en` 指定其一 |
| `promptLang` | `en` | 发给引擎的题目语言：`en` 或 `zh`。改了会影响概率，门槛要重新确认 |
| `jev.model` | `jev-1.13.0` | 固定版本，因为门槛是针对特定版本校准的 |
| `jev.timeoutMs` / `jev.totalTimeoutMs` | `2500` / `4000` | 单个请求与整份计划的时间预算，超过就只显示已完成的结果 |
| `llm.model` | （空） | 必填，端点上的模型名称 |
| `llm.extraBody` | `{}` | 合并进每个请求，例如关闭思考；不能覆盖读取概率用的字段，例如 `max_tokens`、`logprobs` |
| `llm.swapOptions` | `false` | 每题正反顺序各问一次再取平均（请求数加倍） |
| `llm.temperature` | `1` | 校准温度；大于 1 会让概率往 0.5 收拢 |
| `llm.timeoutMs` / `llm.totalTimeoutMs` | `5000` / `20000` | 同上；本地模型请求较多，预算较宽 |
| `*.allowHttpHosts` | `[]` | 可以用 http 连接的非本机主机，只写主机名或 IP，不含端口 |
| `thresholds.*` | 0.4–0.8 | 各标记的门槛，依 Qwen3.8-27B 校准 |
| `limits.maxSteps` | `25` | 超过的步骤只跑命令规则 |

## 数据存在哪里

在 `$DSH_HOME/plan-checkup/`（默认 `~/.dsh/plan-checkup/`）：

- `results/<session>_<callId>.json`：每份计划的体检结果，重新打开计划时还看得到。
- `ledger.jsonl`：每次体检用的引擎、各题答案的概率、延迟与 token 数、计划标题、你的决定（同意执行或要求修改），以及你的 👍 / 👎。不含步骤内容。

插件不会往 session 记录写任何东西。

## 效果如何

我们用刻意埋了问题的合成计划做了评测（代码与数据在 [eval/](eval/README.md)）：210 份用来调整题目与门槛，再用 6 个新情境的 90 份计划做最后验证。验证集上卡片标记的精确率／召回率：

| 标记 | Qwen3.8-27B（OpenAI 兼容端点，英文题目） | 只用规则 | 预训练 Laya |
|---|---|---|---|
| 无法恢复 | 1.00 / 1.00 | 1.00 / 0.35 | 0.07 / 0.80 |
| 影响工作区以外 | 1.00 / 1.00 | 1.00 / 0.13 | 0.11 / 0.77 |
| 需求没提到 | 1.00 / 1.00 | — | 0.10 / 0.05 |
| 描述太模糊 | 0.74 / 1.00 | — | 0.03 / 0.21 |
| 没有验证步骤 | 1.00 / 1.00 | 0.59 / 0.94 | 0.50 / 0.03 |
| 可能漏了需求 | 0.91 / 0.87 | — | 0.28 / 0.70 |

在 vLLM 上用 Qwen3.8-27B，一份计划的中位数是 2.1 秒、p95 是 2.9 秒，约 26 个请求。这些计划比真实的干净，而且每一份都埋了问题，所以这些数字应该看成上限。能力好的 agent 交出的计划很少有这些疏失，实际使用时多数会显示「没发现问题」。

## 意见反馈

这是第一个公开版本，下一步要做什么由大家的反馈决定。请用[反馈表单](https://github.com/Bear0117/dsh-plan-checkup/issues/new?template=feedback.yml)开 issue。细节面板底部的「意见反馈」链接会打开同一张表单，并带上插件版本与引擎；在你自己提交之前，不会发出任何内容。建议附上：

- 标错的步骤与标记，或没有标出来的问题；
- 你的 dsh 版本与判断引擎；
- 可选：计划节录（先删掉私人内容），以及 `ledger.jsonl` 里对应的记录。

## 已知限制

- 它检查的是几种特定的疏失：危险命令、需求没要求的工作、模糊的步骤、缺少测试。它不判断做法对不对，也不判断计划依据的事实是否正确。
- 题目是为写代码的计划设计的；研究或写作类的计划，多数题目用不上。
- 步骤是从计划的顶层列表或标题切出来的：子项目并入所属的步骤，超过 1,200 字的步骤会被截断，不是步骤的段落（目标、背景）不会检查。
- 判断引擎和写计划的是同一个模型时，两者的盲点相同。
- 门槛是用合成数据、依 Qwen3.8-27B 校准的。其他引擎和模型要各自确认，可以利用 `ledger.jsonl` 里的概率和投票。
- 「可能漏了需求」是最弱的一项，请当成较弱的提醒。
- 子代理的计划不会出现审阅卡片（子代理不能向用户提问），所以不会被体检。
- 「要求修改」会取消审阅，反馈要由你自己发送，插件无法代发。
- 这是提示工具，不是安全边界：dsh 的沙箱与审批照常运作。

## 开发

```bash
npm test                  # 单元测试，不需要网络或密钥
npm run dev:llm           # 假的规划模型，固定交出一份 7 步计划（18765 端口）
npm run dev:jev           # 假 Jev，检查请求格式并返回概率（18766 端口）
npm run dev:logprobs      # 给 llm 引擎用的假 logprob 端点（18767 端口）
npm run probe -- …        # 用一份计划测试判断引擎（见上文）
```

`dev/overlay.yml`（假 Jev）和 `dev/overlay-llm.yml`（假 logprob 端点）会启动独立的测试环境，所有服务都在本机，不需要密钥：

```bash
DSH_HOME=.m0/home M0_MOCK_API_KEY=mock dsh web --patch dev/overlay-llm.yml --port 3190 --no-open
```

假服务可以模拟错误：`MOCK_JEV_MODE=401|402|429|529|slow`、`MOCK_LLM_MODE=401|429|503|slow|nologprobs|think`。浏览器端的 `lib/client.js` 是手写的 dsh 客户端模块格式，没有构建步骤。它依赖的 dsh 挂载点的实测记录在 [m0/README.md](m0/README.md)。

## 许可

[MIT](LICENSE)
