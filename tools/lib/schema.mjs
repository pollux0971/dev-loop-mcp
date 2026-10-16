// JSON Schema subset validator (zero dependencies).
// Supports: type (may be an array), required, properties, additionalProperties, items, enum, const,
// minLength, maxLength, pattern, minimum, maximum, minItems, maxItems, oneOf, anyOf, $ref (#/definitions/x).
// Unsupported keywords are reported as errors instead of being silently ignored: "rules we did not understand were skipped" is exactly where false greens come from.

const SUPPORTED = new Set([
  '$schema', '$id', '$comment', 'title', 'description', 'examples', 'default', 'definitions',
  'type', 'required', 'properties', 'additionalProperties', 'items', 'enum', 'const',
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'minItems', 'maxItems',
  'oneOf', 'anyOf', '$ref', 'x-hard',
]);

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(actual, expected) {
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return actual === expected;
}

export function validate(schema, value, root = schema, path = '$') {
  const errors = [];
  if (schema === true) return errors;
  if (schema === false) return [`${path}: 不允許任何值`];
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED.has(key)) errors.push(`${path}: schema 用了不支援的關鍵字 "${key}"`);
  }
  if (schema.$ref) {
    const m = /^#\/definitions\/(.+)$/.exec(schema.$ref);
    const target = m ? root.definitions?.[m[1]] : undefined;
    if (!target) return [...errors, `${path}: 無法解析 $ref ${schema.$ref}`];
    return [...errors, ...validate(target, value, root, path)];
  }
  const actual = typeOf(value);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(actual, t))) {
      return [...errors, `${path}: 型別應為 ${types.join('|')},實際是 ${actual}`];
    }
  }
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    errors.push(`${path}: 應為 ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${path}: 值 ${JSON.stringify(value)} 不在 enum ${JSON.stringify(schema.enum)}`);
  }
  if (actual === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: 長度 < ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: 長度 > ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: 不符合 pattern ${schema.pattern}`);
  }
  if (actual === 'number' || actual === 'integer') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: < ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: > ${schema.maximum}`);
  }
  if (actual === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: 項目數 < ${schema.minItems}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: 項目數 > ${schema.maxItems}`);
    if (schema.items) value.forEach((v, i) => errors.push(...validate(schema.items, v, root, `${path}[${i}]`)));
  }
  if (actual === 'object') {
    for (const req of schema.required ?? []) {
      if (!(req in value)) errors.push(`${path}: 缺必填欄位 ${req}`);
    }
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) errors.push(...validate(props[k], v, root, `${path}.${k}`));
      else if (schema.additionalProperties === false) errors.push(`${path}: 不認識的欄位 ${k}`);
      else if (typeof schema.additionalProperties === 'object') {
        errors.push(...validate(schema.additionalProperties, v, root, `${path}.${k}`));
      }
    }
  }
  if (schema.oneOf) {
    const passing = schema.oneOf.filter((s) => validate(s, value, root, path).length === 0).length;
    if (passing !== 1) errors.push(`${path}: 應恰好符合 oneOf 其中一個,實際符合 ${passing} 個`);
  }
  if (schema.anyOf) {
    if (!schema.anyOf.some((s) => validate(s, value, root, path).length === 0)) errors.push(`${path}: 不符合 anyOf 任何一個`);
  }
  return errors;
}

export function assertValid(schema, value, label) {
  const errors = validate(schema, value);
  if (errors.length) {
    const e = new Error(`${label} 驗證失敗:\n  - ${errors.join('\n  - ')}`);
    e.errors = errors;
    throw e;
  }
  return value;
}
