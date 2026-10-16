// Schemas for all machine-readable formats. Changing this = changing a hard contract (the on-disk format), which needs a user decision.

export const NODE_ID = {
  phase: '^[a-z0-9][a-z0-9-]*/v[0-9]+(\\.[0-9]+)*$',
  integration: '^I[0-9]+$',
  shared: '^shared/[a-z0-9][a-z0-9-]*$',
};
export const CONTRACT_REF = '^contracts@[0-9]+$';

const str = { type: 'string', minLength: 1 };
const strArr = { type: 'array', items: str };

// test-fix: a leg that changes only tests, run after the dev leg reports "the test or steps are wrong" and the Critic or the user agrees (v4)
// characterize: in an existing project (brownfield), the first leg when a node has to change existing code: it only writes tests that pin down current behavior, and they must be green on the current code (v4.5)
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
    // v4: which version this node belongs to (written by dlm intake bundle, e.g. v1, v2). Used only for display and grouping; the order between versions comes from depends_on the previous version's integration point
    release: str,
    // v4.5: where this node's test files go (glob). If absent, inferred from owns (*.test.* / *.spec.* under the owns directories, plus the project language's conventions)
    tests: strArr,
    // v4.5: the existing code to change. targets are the existing files that will be changed, tests are the test files that pin down their current behavior, cmd is the command that must be green on the current code.
    // When there are targets (and no skip), the pipeline gets an extra characterize leg at the very front. skip = the reason for not pinning (e.g. the behavior of these files is going to be replaced entirely)
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
    // v4.5: greenfield = start from zero (uses the template's TS / vitest / cucumber); brownfield = existing project (the gate runs the project's own test command)
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
        // v4.5: the command each name in the chain maps to (e.g. { "test": "python3 -m pytest -q" }). Names not listed still run as npm scripts
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
    // v4: version gate. gate_next_version = nodes that depend on an integration point do not start until the integration point is merged "and" you have confirmed it by hand trial
    integration: {
      type: 'object',
      additionalProperties: false,
      properties: { gate_next_version: { type: 'boolean' }, precheck_green: { type: 'boolean' } },
    },
    // v4: command run when there is a new pending decision (env var DLM_NOTIFY_TEXT holds the content). null = no notification
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
      // v4.6: accounts = the accounts this role rotates through (created by dlm account add); model = that CLI's model name
      properties: { cmd: { type: ['string', 'null'] }, timeout_minutes: { type: 'integer', minimum: 1 }, accounts: strArr, model: str },
    },
  },
};

const finding = {
  type: 'object',
  required: ['check', 'detail'],
  properties: { check: str, detail: str, evidence: { type: 'string' } },
};

/** Required fields of each event type. seq/ts/actor/type are filled in by ledger.append. */
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
  // class: infra (429, 5xx, connection, failed to start) does not count as a worker attempt and is re-dispatched with backoff; quality counts as one attempt as usual
  worker_failed: {
    required: ['dispatch_id', 'reason'],
    // halted (v4): a worker collected on dlm halt; does not count as an attempt, no backoff
    // limited_account / limited_until (v4.6): this time the account quota ran out, and that account cools down until limited_until; switched = another account is available, not counted as a consecutive failure
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
    // main_sha: where main was when the gate ran. If main's code changed before the merge, this gate result is stale and must be re-run
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
  // v4: insert a leg (currently only test-fix). The node goes back to todo, the next dispatch does this leg first, then continues with the original next leg
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
      // v4.7.3: which not-yet-decided proposals this proposal replaces (ref, e.g. node:p-001). A replaced one is no longer listed as pending and can no longer be approved
      supersedes: strArr,
      // question holds only text dlm generated itself; worker / model / git output goes here, and is always fenced when shown to Front
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

// manager / migration: old ledgers from before v4.0 may contain them; kept so that old ledgers still replay
// dp-cli: the name before 4.8.0 (dp was renamed to dlm). Events in old ledgers are not rewritten; new events always write dlm-cli
export const ACTORS = ['orchestrator', 'user', 'critic', 'manager', 'verifier', 'dlm-cli', 'dp-cli', 'migration'];

/**
 * Which events only certain actors may write. After approval authority moved from roles to events, this table is the mechanical version of the responsibility table.
 * Construction-flow events can only be written by the orchestrator; anyone adding an accept by hand is caught by `dlm check ledger`.
 * An unblock by the user (ref starts with user#) is checked separately in ledger.validateEvent.
 */
export const EVENT_ACTORS = {
  decision: ['user', 'critic'],
  e2e_confirm: ['user'],
  resume: ['user'],
  contract_bump: ['dlm-cli', 'dp-cli'],
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
    // v4: when the dev leg finds the test or step definitions themselves wrong (contradicting the gherkin), it sets "test"; dlm then dispatches a test-fix leg instead of re-dispatching the dev leg
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
    // v3 real run: the Critic's reasons often exceeded 1500 characters, and the whole thing was judged malformed and sent back to ask the user. The limit is relaxed; truncate shorter when booking
    reason: { type: 'string', minLength: 1, maxLength: 8000 },
    findings: { type: 'array', items: finding },
    question: { type: 'string' },
    options: { type: 'array', items: { type: 'object', required: ['key', 'label'], properties: { key: str, label: str } } },
    recommendation: { type: 'string' },
  },
};
