# dev-paradigm plugin

把這套開發範式的 **skill 與斜線指令**裝進 Claude Code,不必每個專案都 `init` 一份。

## 這裡面的東西不是手寫的

`plugin/skills/` 與 `plugin/commands/` 是 **`.claude/skills/` 與 `.claude/commands/` 的逐位元組鏡像**,
由 `npx tsx scripts/check-skills-mirror.ts --fix` 產生,並由同一支守門在全 gate 裡釘住。
**不要直接改這個目錄**——改正本,再跑 `--fix`。(理由見 PITFALLS P-103:同一條規則存在多份手工副本,
遲早會各自漂移,然後其中一份開始說謊。)

## 安裝(repo 是 private,需要你自己的 git 認證)

```bash
# 本機直接用(開發/試用)
claude --plugin-dir /path/to/dev-paradigm/plugin

# 從 GitHub 裝
/plugin marketplace add pollux0971/dev-paradigm
/plugin install dev-paradigm@dev-paradigm
```

## 裝了之後

- skill 會帶命名空間:`/dev-paradigm:phase-acceptance`、`/dev-paradigm:decision-record` …
  **跟專案自己 `.claude/skills/` 的同名 skill 不衝突**,兩邊共存。
- 6 個斜線指令照舊:`/phase-done` `/integrate` `/mutate` `/decide` `/sprint` `/feature`。

## plugin 不包含什麼

- **規則正本**(`AGENTS.md` 的五條硬規則、決策權責表)。那是**每個專案自己的**,由 `init` 落地後填寫;
  plugin 只帶「怎麼做事」的流程,不帶「這個專案的邊界在哪」。
- **守門腳本**(`scripts/check-*.ts`)。它們要跑在專案的 CI 與 `package.json` 裡,不是 Claude Code 的擴充。
- **Codex 那一半**。Codex 沒有 plugin 機制,它讀的是專案裡的 `AGENTS.md` 與 `.agents/skills/`。
