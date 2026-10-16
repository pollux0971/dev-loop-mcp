// 所有機器可讀格式的 schema。改這裡 = 改硬約定(磁碟格式),要走使用者決策。

export const NODE_ID = {
  phase: '^[a-z0-9][a-z0-9-]*/v[0-9]+(\\.[0-9]+)*$',
  integration: '^I[0-9]+$',
  shared: '^shared/[a-z0-9][a-z0-9-]*$',
};
export const CONTRACT_REF = '^contracts@[0-9]+$';

const str = { type: 'string', minLength: 1 };
const strArr = { type: 'array', items: str };

// test-fix:實作棒回報「測試或步驟寫錯」、Critic 或使用者認可後,只改測試的一棒(v4)
// characterize:既有專案(brownfield)裡,節點要改到既有程式時排在最前面的一棒:只寫測試、把現有行為釘住,在現在的程式上必須綠(v4.5)
export const LEGS = ['characterize', 'test', 'dev', 'integrate', 'test-fix'];

export const nodeSchema = {
  type: 'object',
  required: ['id', 'kind', 'title', 'intent'],
  additionalProperties: false,
  properties: {
    id: str,
    kind: { enum: ['phase', 'integration', 'shared'] },
    title: str,
    intent: { type: 'string', minLength: 1, maxLength: 300 },
    owns: strArr,
    gherkin: str,
    accept: { type: 'string' },
    standalone: { type: 'string' },
    depends_on: strArr,
    parent: str,
    relation: { enum: ['prereq', 'followup'] },
    tier: { enum: ['strict', 'standard', 'loose'] },
    pipeline: { type: 'array', items: { enum: LEGS }, minItems: 1 },
    // v4:這個節點屬於哪個版本(dp intake bundle 寫入,例 v1、v2)。只用來顯示與分組;版本之間的先後靠 depends_on 上一版的整合點
    release: str,
    // v4.5:這個節點的測試檔放哪裡(glob)。沒寫就從 owns 推(owns 目錄底下的 *.test.* / *.spec.*,加上專案語言的慣例)
    tests: strArr,
    // v4.5:要改到的既有程式。targets 是會被改的既有檔,tests 是釘住它們現有行為的測試檔,cmd 是在現在的程式上必須綠的指令。
    // 有 targets(而且沒寫 skip)時,pipeline 最前面多一棒 characterize。skip = 不釘的理由(例:這些檔的行為本來就要整個換掉)
    characterize: {
      type: 'object',
      additionalProperties: false,
      properties: { targets: strArr, tests: strArr, cmd: str, skip: str },
    },
  },
};

export const dagSchema = {
  type: 'object',
  required: ['version', 'nodes'],
  additionalProperties: false,
  properties: {
    $comment: { type: 'string' },
    version: { const: 1 },
    nodes: { type: 'array', items: nodeSchema },
  },
};

export const configSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    $comment: { type: 'string' },
    main_branch: str,
    worktree_dir: str,
    platform: { enum: ['claude', 'generic'] },
    // v4.5:greenfield = 從零開始(用範本的 TS / vitest / cucumber);brownfield = 既有專案(gate 跑專案自己的測試指令)
    project: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { enum: ['greenfield', 'brownfield'] },
        language: { enum: ['node', 'python', 'go', 'rust', 'other'] },
      },
    },
    caps: {
      type: 'object',
      additionalProperties: false,
      properties: {
        parallel: { type: 'integer', minimum: 1 },
        unmerged: { type: 'integer', minimum: 1 },
        drift: { type: 'integer', minimum: 0 },
        attempts: { type: 'integer', minimum: 1 },
        lease_minutes: { type: 'integer', minimum: 1 },
        infra_halt_after: { type: 'integer', minimum: 1 },
        infra_backoff_seconds: { type: 'number', minimum: 0 },
        infra_backoff_max_minutes: { type: 'number', minimum: 0 },
        test_reopens: { type: 'integer', minimum: 0 },
        account_cooldown_minutes: { type: 'number', minimum: 1 },
      },
    },
    pipeline: { type: 'object', additionalProperties: { type: 'array', items: { enum: LEGS } } },
    gates: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chain: strArr, timeout_minutes: { type: 'integer', minimum: 1 }, install: { enum: ['auto', 'link', 'ci-offline'] },
        // v4.5:chain 裡的名字對應的指令(例 { "test": "python3 -m pytest -q" })。沒列的名字照舊跑 npm script
        commands: { type: 'object', additionalProperties: str },
      },
    },
    auth: {
      type: 'object',
      additionalProperties: false,
      properties: { window_minutes: { type: 'integer', minimum: 1 } },
    },
    checks: {
      type: 'object',
      additionalProperties: false,
      properties: {
        placeholders: { type: 'object', additionalProperties: false, properties: { exclude: strArr } },
      },
    },
    autonomy: {
      type: 'object',
      additionalProperties: false,
      properties: { level: { type: 'integer', minimum: 0, maximum: 2 } },
    },
    budget: {
      type: 'object',
      additionalProperties: false,
      properties: { daily_usd: { type: 'number', minimum: 0 } },
    },
    // v4:版本整合關卡。gate_next_version = 依賴整合點的節點,要等整合點合併「而且」你試用確認過才開工
    integration: {
      type: 'object',
      additionalProperties: false,
      properties: { gate_next_version: { type: 'boolean' } },
    },
    // v4:有新的待決事項時執行的指令(環境變數 DP_NOTIFY_TEXT 是內容)。null = 不通知
    notify: {
      type: 'object',
      additionalProperties: false,
      properties: { cmd: { type: ['string', 'null'] } },
    },
    agents: {
      type: 'object',
      additionalProperties: false,
      properties: {
        worker: { $ref: '#/definitions/agent' },
        critic: { $ref: '#/definitions/agent' },
        verifier: {
          type: 'object',
          additionalProperties: false,
          properties: {
            backend: { enum: ['none', 'cmd'] },
            cmd: { type: ['string', 'null'] },
            accounts: strArr, model: str,
            runs: { type: 'integer', minimum: 1, maximum: 3 },
            max_input_chars: { type: 'integer', minimum: 500 },
            timeout_seconds: { type: 'integer', minimum: 5 },
          },
        },
      },
    },
    paths: {
      type: 'object',
      additionalProperties: false,
      properties: { forbidden: strArr, tests: strArr, rules: strArr },
    },
    verify: {
      type: 'object',
      additionalProperties: false,
      properties: {
        rerun_allow: strArr,
        rerun_timeout_seconds: { type: 'integer', minimum: 1 },
        dry_run_cmd: { type: ['string', 'null'] },
        mutation: {
          type: 'object',
          additionalProperties: false,
          properties: {
            cmd: { type: ['string', 'null'] }, report: str, min: { type: 'number', minimum: 0, maximum: 100 },
            min_strict: { type: 'number', minimum: 0, maximum: 100 },
            timeout_minutes: { type: 'integer', minimum: 1 }, include: strArr,
          },
        },
      },
    },
    limits: {
      type: 'object',
      additionalProperties: false,
      properties: {
        rules_bytes: { type: 'integer', minimum: 500 },
        prompt_bytes: { type: 'integer', minimum: 1000 },
      },
    },
  },
  definitions: {
    agent: {
      type: 'object',
      additionalProperties: false,
      // v4.6:accounts = 這個角色輪流用的帳號(dp account add 建的);model = 那個 CLI 的模型名稱
      properties: { cmd: { type: ['string', 'null'] }, timeout_minutes: { type: 'integer', minimum: 1 }, accounts: strArr, model: str },
    },
  },
};

const finding = {
  type: 'object',
  required: ['check', 'detail'],
  properties: { check: str, detail: str, evidence: { type: 'string' } },
};

/** 每種事件的必填欄位。seq/ts/actor/type 由 ledger.append 補。 */
export const EVENT_FIELDS = {
  node_added: { required: ['node_id', 'approved_by'], props: { node_id: str, approved_by: str, spec_sha: str } },
  node_imported: { required: ['node_id', 'status', 'source'], props: { node_id: str, status: { enum: ['done', 'todo', 'blocked'] }, source: str } },
  dispatch: {
    required: ['dispatch_id', 'node_id', 'leg', 'attempt', 'branch', 'worktree', 'base_sha', 'lease_until'],
    props: {
      dispatch_id: str, node_id: str, leg: { enum: LEGS }, attempt: { type: 'integer', minimum: 1 },
      branch: str, worktree: str, base_sha: str, leg_base: str, envelope_sha: str, lease_until: str,
      sandbox: str, sandbox_backend: str, account: str,
    },
  },
  launched: { required: ['dispatch_id', 'pid'], props: { dispatch_id: str, pid: { type: 'integer' }, container: str, nm_fingerprint: str } },
  worker_done: {
    required: ['dispatch_id', 'commit', 'report_path'],
    props: { dispatch_id: str, commit: str, report_path: str, changes: { type: 'integer', minimum: 0 }, violations_path: str },
  },
  worker_blocked: { required: ['dispatch_id', 'reason'], props: { dispatch_id: str, reason: str, spawn: { type: 'object' }, report_path: str, violations_path: str, fix_leg: { enum: ['test'] } } },
  // class:infra(429、5xx、連線、沒啟動成功)不算 worker 的嘗試次數,改退避重派;quality 照常算一次
  worker_failed: {
    required: ['dispatch_id', 'reason'],
    // halted(v4):dp halt 時收掉的 worker,不算嘗試次數、不退避
    // limited_account / limited_until(v4.6):這次是帳號額度用完,那個帳號冷卻到 limited_until;switched = 有別的帳號可以換,不算連續失敗
    props: {
      dispatch_id: str, reason: str, class: { enum: ['infra', 'quality', 'halted'] }, retry_after: str,
      limited_account: str, limited_until: str, switched: { type: 'boolean' },
    },
  },
  verify: {
    required: ['dispatch_id', 'results'],
    props: {
      dispatch_id: str,
      results: {
        type: 'array',
        items: {
          type: 'object',
          required: ['check', 'outcome'],
          properties: {
            check: str,
            outcome: { enum: ['PASS', 'FAIL', 'NO_OBJECTION', 'ABSTAIN', 'SKIPPED'] },
            detail: { type: 'string' },
            evidence: { type: 'string' },
            model: { type: 'string' },
          },
        },
      },
    },
  },
  gates: {
    required: ['dispatch_id', 'ok', 'results'],
    // main_sha:跑 gate 時主線的位置。合併前主線的程式碼變了,這份 gate 結果就過期,要重跑
    props: {
      dispatch_id: str, ok: { type: 'boolean' }, tree_sha: { type: 'string' }, main_sha: { type: 'string' },
      results: { type: 'array' }, output_tail: { type: 'string' },
    },
  },
  critic: {
    required: ['ref', 'verdict', 'reason'],
    props: { ref: str, dispatch_id: str, verdict: { enum: ['PASS', 'FAIL', 'ASK_USER'] }, reason: str, findings: { type: 'array' } },
  },
  leg_done: { required: ['dispatch_id', 'node_id', 'leg'], props: { dispatch_id: str, node_id: str, leg: { enum: LEGS } } },
  // v4:插入一棒(目前只有 test-fix)。節點回到 todo,下一次派工先做這一棒,做完再接原本的下一棒
  leg_reopen: { required: ['node_id', 'leg', 'ref'], props: { node_id: str, leg: { enum: ['test-fix'] }, ref: str, findings: { type: 'array', items: finding } } },
  reject: { required: ['dispatch_id', 'node_id', 'reason'], props: { dispatch_id: str, node_id: str, reason: str, findings: { type: 'array', items: finding } } },
  accept: { required: ['dispatch_id', 'node_id', 'merge_sha'], props: { dispatch_id: str, node_id: str, merge_sha: str } },
  block: { required: ['node_id', 'reason'], props: { node_id: str, reason: str } },
  unblock: { required: ['node_id', 'ref'], props: { node_id: str, ref: str, note: { type: 'string' }, utterance_sha: str, auth: { enum: ['utterance', 'tty', 'trust', 'off'] }, } },
  decision_request: {
    required: ['ref', 'question', 'options'],
    props: {
      ref: str, question: str,
      options: { type: 'array', minItems: 2, items: { type: 'object', required: ['key', 'label'], properties: { key: str, label: str } } },
      recommendation: { type: 'string' }, reason: { type: 'string' }, blocks: strArr, from: str, detail_path: { type: 'string' },
      // question 只放 dp 自己產生的文字;worker / 模型 / git 輸出放這裡,給 Front 看時一律加圍欄
      untrusted_text: { type: 'string' }, untrusted_source: { type: 'string' },
    },
  },
  decision: {
    required: ['ref', 'choice', 'verbatim'],
    props: { ref: str, choice: str, verbatim: str, delegated: { type: 'boolean' }, utterance_sha: str, auth: { enum: ['utterance', 'tty', 'trust', 'off'] }, },
  },
  e2e_request: { required: ['node_id', 'scenarios'], props: { node_id: str, scenarios: { type: 'array' } } },
  e2e_confirm: { required: ['node_id', 'ok', 'verbatim'], props: { node_id: str, ok: { type: 'boolean' }, verbatim: str, utterance_sha: str, auth: { enum: ['utterance', 'tty', 'trust', 'off'] }, } },
  halt: { required: ['reason'], props: { reason: str } },
  resume: { required: ['verbatim'], props: { verbatim: str, utterance_sha: str, auth: { enum: ['utterance', 'tty', 'trust', 'off'] }, } },
  cost: { required: ['dispatch_id', 'usd'], props: { dispatch_id: str, usd: { type: 'number', minimum: 0 }, role: str, account: str } },
  contract_bump: { required: ['from', 'to', 'decision_ref', 'stale'], props: { from: { type: 'integer' }, to: { type: 'integer' }, decision_ref: str, stale: strArr } },
  inbox_viewed: { required: [], props: {} },
  note: { required: ['text'], props: { text: str, node_id: str, dispatch_id: str } },
};

// manager / migration:v4.0 以前的帳本裡可能有,留著讓舊帳本重播得過
export const ACTORS = ['orchestrator', 'user', 'critic', 'manager', 'verifier', 'dp-cli', 'migration'];

/**
 * 哪些事件只能由哪些 actor 寫。批准權從角色搬到事件之後,這張表就是權責表的機械版。
 * 施工流程的事件只有 orchestrator 能寫;任何人手動補一筆 accept 都會被 `dp check ledger` 抓到。
 * 使用者解除封鎖(ref 以 user# 開頭)另外在 ledger.validateEvent 檢查。
 */
export const EVENT_ACTORS = {
  decision: ['user', 'critic'],
  e2e_confirm: ['user'],
  resume: ['user'],
  contract_bump: ['dp-cli'],
  node_imported: ['migration'],
  dispatch: ['orchestrator'],
  launched: ['orchestrator'],
  worker_done: ['orchestrator'],
  worker_blocked: ['orchestrator'],
  worker_failed: ['orchestrator'],
  gates: ['orchestrator'],
  accept: ['orchestrator'],
  reject: ['orchestrator'],
  leg_done: ['orchestrator'],
  leg_reopen: ['orchestrator'],
  e2e_request: ['orchestrator'],
  node_added: ['orchestrator'],
  block: ['orchestrator'],
  verify: ['verifier'],
  critic: ['critic'],
  unblock: ['orchestrator', 'user'],
};

export function eventSchema(type) {
  const spec = EVENT_FIELDS[type];
  if (!spec) return null;
  return {
    type: 'object',
    required: ['seq', 'ts', 'actor', 'type', ...spec.required],
    additionalProperties: false,
    properties: {
      seq: { type: 'integer', minimum: 1 },
      ts: str,
      actor: { enum: ACTORS },
      type: { const: type },
      ...spec.props,
      prev_hash: str, mac: str, chain_start: { const: true },
    },
  };
}

export const claimSchema = {
  oneOf: [
    {
      type: 'object',
      required: ['text', 'evidence'],
      additionalProperties: false,
      properties: {
        text: str,
        evidence: {
          type: 'object',
          required: ['cmd', 'exit'],
          additionalProperties: false,
          properties: { cmd: str, exit: { type: 'integer' }, stdout_tail: { type: 'string', maxLength: 4000 } },
        },
      },
    },
    {
      type: 'object',
      required: ['text', 'unverified', 'why'],
      additionalProperties: false,
      properties: { text: str, unverified: { const: true }, why: str },
    },
  ],
};

export const spawnSchema = {
  type: 'object',
  required: ['id', 'title', 'intent', 'relation', 'owns'],
  additionalProperties: false,
  properties: {
    id: str, title: str, intent: { type: 'string', minLength: 1, maxLength: 300 },
    relation: { enum: ['prereq', 'followup'] }, owns: strArr, gherkin_draft: { type: 'string' },
    standalone: { type: 'string' }, accept: { type: 'string' },
  },
};

export const reportSchema = {
  type: 'object',
  required: ['dispatch_id', 'kind', 'summary', 'claims'],
  additionalProperties: false,
  properties: {
    dispatch_id: str,
    kind: { enum: ['done', 'blocked', 'escalation'] },
    summary: { type: 'string', minLength: 1, maxLength: 800 },
    claims: { type: 'array', items: claimSchema },
    ticket_problems: strArr,
    // v4:實作棒發現測試或步驟定義本身寫錯(與 gherkin 矛盾)時填 "test",dp 會改派 test-fix 棒,不再重派實作棒
    fix_leg: { enum: ['test'] },
    spawn: spawnSchema,
    local_modifications: strArr,
  },
};

export const envelopeSchema = {
  type: 'object',
  required: ['dispatch_id', 'node_id', 'leg', 'attempt', 'objective', 'authority', 'base_ref', 'branch',
    'allowed_paths', 'forbidden_paths', 'acceptance', 'done_when', 'report_path'],
  additionalProperties: false,
  properties: {
    dispatch_id: str, node_id: str, leg: { enum: LEGS }, attempt: { type: 'integer', minimum: 1 },
    objective: str,
    authority: { type: 'object' }, base_ref: str, branch: str,
    allowed_paths: strArr, forbidden_paths: strArr,
    acceptance: { type: 'array', items: { type: 'object', required: ['cmd', 'expect_exit'], properties: { cmd: str, expect_exit: { type: 'integer' } } } },
    done_when: str, report_path: str,
    findings: { type: 'array', items: finding },
  },
};

export const verdictSchema = {
  type: 'object',
  required: ['verdict', 'reason'],
  additionalProperties: false,
  properties: { verdict: { enum: ['FAIL', 'NO_OBJECTION', 'ABSTAIN'] }, reason: { type: 'string', maxLength: 600 } },
};

export const criticSchema = {
  type: 'object',
  required: ['verdict', 'reason'],
  additionalProperties: false,
  properties: {
    verdict: { enum: ['PASS', 'FAIL', 'ASK_USER'] },
    // v3 實測:Critic 的理由常超過 1500 字,整筆被判格式錯誤後退回問使用者。上限放寬,記帳時再截短
    reason: { type: 'string', minLength: 1, maxLength: 8000 },
    findings: { type: 'array', items: finding },
    question: { type: 'string' },
    options: { type: 'array', items: { type: 'object', required: ['key', 'label'], properties: { key: str, label: str } } },
    recommendation: { type: 'string' },
  },
};
