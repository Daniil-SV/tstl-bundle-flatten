var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toCommonJS = (from) => {
  var entry = (__moduleCache ??= new WeakMap).get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function") {
    for (var key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(entry, key))
        __defProp(entry, key, {
          get: __accessProp.bind(from, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
  }
  __moduleCache.set(from, entry);
  return entry;
};
var __moduleCache;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// src/index.ts
var exports_src = {};
__export(exports_src, {
  default: () => src_default,
  transformLines: () => transformLines
});
module.exports = __toCommonJS(exports_src);

// src/lines.ts
function splitLines(code) {
  return code.split(`
`).map((text, src) => ({ text, src }));
}
function render(lines) {
  return lines.map((line) => line.text).join(`
`);
}
function lineMap(lines) {
  return lines.map((line) => line.src);
}
function inserted(text) {
  return { text, src: -1 };
}
function isBlank(text) {
  return text.trim() === "";
}

// src/flatten.ts
var MODULE = /\["([^"]+)"\] = function\([^)]*\)\s*\n([\s\S]*?)\n end,/dg;
var EXPORTS_TABLE = "local ____exports = {}";
var REQUIRE_LINE = /^[ \t]*(?:local ____\w+ = )?require\("[^"]+"\)$/;
var IMPORT_LINE = /^([ \t]*)local (\w+) = (____\w+)\.(\w+)$/;
var NAMESPACE_REQUIRE = /^[ \t]*local \w+ = require\("([^"]+)"\)$/;
var INDENT = /^ {4}/;
var RETURN_EXPORTS = /(?:^|\n)return (?:____exports|\{[^}]*\})$/;
function sanitizeModuleName(name) {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}
function stripExports(lines, defaultAlias) {
  const rewritten = lines.map((line) => {
    let text = line.text;
    if (defaultAlias !== null) {
      text = text.replace(/function ____exports\.default(\s*\()/g, `local function ${defaultAlias}$1`);
      text = text.replace(/____exports\.default\s*=\s*([^\n]*)/g, (_m, rhs) => `local ${defaultAlias} = ${rhs}`);
      text = text.replace(/____exports\.default\b/g, defaultAlias);
    }
    text = text.replace(/function ____exports\.(\w+)\s*\(/g, "local function $1(").replace(/____exports\.(\w+)\s*=/g, "local $1 =").replace(/____exports\./g, "");
    return { ...line, text };
  });
  const index = rewritten.findIndex((line) => line.text.endsWith(EXPORTS_TABLE));
  if (index === -1)
    return rewritten;
  const prefix = rewritten[index].text.slice(0, -EXPORTS_TABLE.length);
  const rest = rewritten.slice(index + 1);
  if (prefix !== "" && rest.length > 0) {
    rest[0] = { ...rest[0], text: prefix + rest[0].text };
  }
  return [...rewritten.slice(0, index), ...rest];
}
function stripReturn(lines) {
  const body = render(lines);
  const stripped = body.replace(RETURN_EXPORTS, "");
  if (stripped === body)
    return lines;
  return lines.slice(0, stripped === "" ? 0 : stripped.split(`
`).length);
}
function stripImports(lines, defaultAliases) {
  const result = [];
  const requireMap = new Map;
  for (let index = 0;index < lines.length; index++) {
    const line = lines[index];
    if (line.text === "do") {
      const close = lines.findIndex((other, at) => at > index && other.text === "end");
      if (close !== -1 && lines.slice(index + 1, close).some((other) => REQUIRE_LINE.test(other.text))) {
        for (const unwrapped of stripImports(lines.slice(index + 1, close), defaultAliases)) {
          result.push({ ...unwrapped, text: unwrapped.text.replace(INDENT, "") });
        }
        index = close;
        continue;
      }
    }
    const requireMatch = line.text.match(/^([ \t]*)local (____\w+) = require\("([^"]+)"\)$/);
    if (requireMatch) {
      requireMap.set(requireMatch[2], requireMatch[3]);
      continue;
    }
    if (REQUIRE_LINE.test(line.text))
      continue;
    const match = IMPORT_LINE.exec(line.text);
    if (!match) {
      result.push(line);
      continue;
    }
    const [, indent, localName, requireVar, exportName] = match;
    if (exportName === "default") {
      const modulePath = requireMap.get(requireVar);
      const alias = modulePath !== undefined ? defaultAliases.get(modulePath) : undefined;
      if (alias) {
        if (localName === alias)
          continue;
        result.push({ ...line, text: `${indent}local ${localName} = ${alias}` });
        continue;
      }
    }
    if (localName === exportName)
      continue;
    result.push({ ...line, text: `${indent}local ${localName} = ${exportName}` });
  }
  return result;
}
function stripEmptyScopes(lines) {
  const result = [];
  for (let index = 0;index < lines.length; index++) {
    if (lines[index].text !== "do") {
      result.push(lines[index]);
      continue;
    }
    let end = index + 1;
    while (end < lines.length && isBlank(lines[end].text))
      end++;
    if (end < lines.length && lines[end].text.trimStart() === "end") {
      index = end;
      continue;
    }
    result.push(lines[index]);
  }
  return result;
}
function trimLines(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && isBlank(lines[start].text))
    start++;
  while (end > start && isBlank(lines[end - 1].text))
    end--;
  if (start >= end)
    return [];
  const trimmed = lines.slice(start, end);
  trimmed[0] = { ...trimmed[0], text: trimmed[0].text.trimStart() };
  trimmed[trimmed.length - 1] = {
    ...trimmed[trimmed.length - 1],
    text: trimmed[trimmed.length - 1].text.trimEnd()
  };
  return trimmed;
}
function computeDefaultAlias(moduleName, lines) {
  const text = render(lines);
  if (!/____exports\.default\b/.test(text))
    return null;
  return `____default_${sanitizeModuleName(moduleName)}`;
}
function flattenLines(lines, skipModules) {
  const code = render(lines);
  const runtimeStart = code.indexOf(`
local ____modules = {}
`);
  if (runtimeStart < 0)
    return lines;
  const header = code.slice(0, runtimeStart + 1);
  const headerLineCount = header.split(`
`).length - 1;
  const moduleEntries = [];
  MODULE.lastIndex = 0;
  let match;
  while ((match = MODULE.exec(code)) !== null) {
    if (skipModules.includes(match[1]))
      continue;
    const bodyStart = match.indices[2][0];
    const firstLine = code.slice(0, bodyStart).split(`
`).length - 1;
    const bodyLines = lines.slice(firstLine, firstLine + match[2].split(`
`).length);
    moduleEntries.push({ name: match[1], bodyLines });
  }
  const defaultAliases = new Map;
  for (const entry of moduleEntries) {
    defaultAliases.set(entry.name, computeDefaultAlias(entry.name, entry.bodyLines));
  }
  const bodies = [];
  for (const entry of moduleEntries) {
    const alias = defaultAliases.get(entry.name) ?? null;
    const body = trimLines(stripEmptyScopes(stripImports(stripReturn(stripExports(entry.bodyLines, alias)), defaultAliases)));
    bodies.push(body.length > 0 ? body : [inserted("")]);
  }
  const result = lines.slice(0, headerLineCount);
  if (bodies.length === 0)
    result.push(inserted(""));
  for (const [index, body] of bodies.entries()) {
    if (index > 0)
      result.push(inserted(""));
    result.push(...body);
  }
  for (const line of result) {
    const namespace = NAMESPACE_REQUIRE.exec(line.text);
    if (namespace !== null) {
      throw new Error(`tstl-bundle-flatten: cannot flatten a namespace import of "${namespace[1]}". ` + "Import the names themselves.");
    }
  }
  return result;
}

// src/format.ts
var RE_COMMENT = /^\s*--/;
var RE_DOC_COMMENT = /^\s*---/;
var RE_BLANK = /^\s*$/;
var RE_LOCAL = /^\s*local\b/;
var RE_END = /^\s*end\b/;
var RE_BLOCK_OPENER = /(?:then|do|else|repeat)$/;
var RE_FUNCTION_HEAD = /\bfunction\b.*\)\s*$/;
var CONTINUES_END = /^(?:end\b|else\b|elseif\b|\)|[}\]]|,)/;
function afterWhitespace({ lines, at }, pattern) {
  for (let index = at;index < lines.length; index++) {
    const { text } = lines[index];
    if (isBlank(text))
      continue;
    return pattern.test(text.trimStart());
  }
  return false;
}
var RULES = [
  {
    matches: (pair) => /^[ \t]*end$/.test(pair.previous) && (pair.atEof || pair.next !== "") && !afterWhitespace(pair, CONTINUES_END),
    consumesNext: false
  },
  {
    matches: ({ previous, next, atEof }) => /^[)}]$/.test(previous) && (atEof || next !== "") && !/^[)}]/.test(next),
    consumesNext: false
  },
  {
    matches: ({ previous, next }) => /^[ \t]*local (?!function\b)\w/.test(previous) && /^[^\S\n]*(?!local\b|--)\S/.test(next),
    guard: ({ previous }) => !RE_FUNCTION_HEAD.test(previous.trimEnd()),
    consumesNext: true
  },
  {
    matches: ({ previous, next }) => previous.length > 0 && /^[^\S\n]*local (?!function\b)\w/.test(next),
    guard: ({ previous }) => !RE_LOCAL.test(previous) && !RE_COMMENT.test(previous) && !RE_BLANK.test(previous) && !RE_BLOCK_OPENER.test(previous.trimEnd()) && !RE_FUNCTION_HEAD.test(previous.trimEnd()),
    consumesNext: true
  },
  {
    matches: ({ previous, next }) => previous.length > 0 && /^[^\S\n]*\w[\w.:]*\([^)]*$/.test(next),
    guard: ({ previous }) => !RE_COMMENT.test(previous) && !RE_BLANK.test(previous) && !RE_END.test(previous) && !RE_BLOCK_OPENER.test(previous.trimEnd()) && !RE_FUNCTION_HEAD.test(previous.trimEnd()),
    consumesNext: true
  },
  {
    matches: ({ previous, next }) => previous.length > 0 && /^[^\S\n]*(?:if|for|while|repeat|return)\b/.test(next),
    guard: ({ previous }) => !RE_BLOCK_OPENER.test(previous.trimEnd()) && !RE_FUNCTION_HEAD.test(previous.trimEnd()) && !RE_END.test(previous) && !RE_DOC_COMMENT.test(previous) && !RE_BLANK.test(previous),
    consumesNext: true
  },
  {
    matches: ({ previous, next }) => previous.length > 0 && /^[^\S\n]*---/.test(next),
    guard: ({ previous }) => !RE_COMMENT.test(previous) && !RE_BLANK.test(previous),
    consumesNext: true
  },
  {
    matches: ({ previous, next }) => previous.length > 0 && /^[^\S\n]*(?:local )?function\b/.test(next),
    guard: ({ previous }) => !RE_COMMENT.test(previous) && !RE_BLANK.test(previous),
    consumesNext: true
  }
];
function applyRule(lines, rule) {
  const result = [];
  for (let index = 0;index < lines.length; index++) {
    result.push(lines[index]);
    const next = lines[index + 1];
    if (next === undefined)
      continue;
    const pair = {
      previous: lines[index].text,
      next: next.text,
      atEof: index + 2 === lines.length && next.text === "",
      lines,
      at: index + 1
    };
    if (!rule.matches(pair))
      continue;
    if (rule.guard === undefined || rule.guard(pair)) {
      result.push(inserted(""));
    }
    if (rule.consumesNext) {
      result.push(next);
      index++;
    }
  }
  return result;
}
function formatLines(lines) {
  return RULES.reduce(applyRule, lines);
}

// src/concat.ts
function flattenConcatChains(lines) {
  return lines.map((line) => line.text.includes("..") ? { ...line, text: rewrite(line.text) } : line);
}
function codeMask(text) {
  const mask = Array.from({ length: text.length }, () => true);
  for (let index = 0;index < text.length; index++) {
    const character = text[index];
    if (character === "-" && text[index + 1] === "-") {
      mask.fill(false, index);
      return mask;
    }
    if (character === '"' || character === "'") {
      mask[index] = false;
      for (index++;index < text.length; index++) {
        mask[index] = false;
        if (text[index] === "\\") {
          if (index + 1 < text.length)
            mask[++index] = false;
          continue;
        }
        if (text[index] === character)
          break;
      }
      continue;
    }
    const long = /^\[=*\[/.exec(text.slice(index));
    if (long) {
      const close = text.indexOf(long[0].replace(/\[$/, "]").replace(/^\[/, "]"), index + long[0].length);
      mask.fill(false, index, close === -1 ? text.length : close + long[0].length);
      if (close === -1)
        return mask;
      index = close + long[0].length - 1;
    }
  }
  return mask;
}
var IDENTIFIER_END = /[\w\]")]/;
var LOOSER = /(?:^|[^\w])(?:or|and|not|if)(?:[^\w]|$)|[<>~=]=|[<>]/;
function rewrite(text) {
  const mask = codeMask(text);
  const opens = [];
  const drop = new Set;
  for (let index = 0;index < text.length; index++) {
    if (!mask[index])
      continue;
    if (text[index] === "(") {
      opens.push(index);
      continue;
    }
    if (text[index] !== ")")
      continue;
    const open = opens.pop();
    if (open === undefined)
      continue;
    const before = text.slice(0, open).trimEnd();
    const after = text.slice(index + 1).trimStart();
    if (IDENTIFIER_END.test(before.slice(-1)))
      continue;
    if (!before.endsWith("..") && !after.startsWith(".."))
      continue;
    const inner = insideConcatOnly(text, mask, open + 1, index);
    if (inner) {
      drop.add(open);
      drop.add(index);
    }
  }
  return drop.size === 0 ? text : [...text].filter((_character, index) => !drop.has(index)).join("");
}
function insideConcatOnly(text, mask, from, to) {
  let depth = 0;
  let concatenates = false;
  let own = "";
  for (let index = from;index < to; index++) {
    if (!mask[index]) {
      own += " ";
      continue;
    }
    const character = text[index];
    if (character === "(" || character === "[" || character === "{")
      depth++;
    else if (character === ")" || character === "]" || character === "}")
      depth--;
    if (depth > 0) {
      own += " ";
      continue;
    }
    own += character;
    if (character === "." && text[index + 1] === "." && text[index - 1] !== ".")
      concatenates = true;
  }
  return concatenates && !LOOSER.test(own);
}

// src/shake.ts
var DARKLUA_CONFIG = {
  rules: ["remove_unused_variable", "remove_empty_do"],
  generator: "retain_lines"
};
var HEADER_COMMENT = /^--\[\[[^\n]*\]\]$/;
var darklua;
function loadDarklua() {
  if (darklua)
    return darklua;
  try {
    darklua = require("darklua-wasm");
  } catch {
    throw new Error("tstl-bundle-flatten: the `shake` option requires darklua-wasm as a peer dependency. " + "Install it with: bun add -D darklua-wasm");
  }
  return darklua;
}
function shakeLines(lines) {
  const input = flattenConcatChains(lines);
  const shaken = loadDarklua().process_code(render(input), DARKLUA_CONFIG);
  const shakenLines = shaken.split(`
`);
  const aligned = shakenLines.length === input.length;
  const tracked = shakenLines.map((text, index) => ({
    text,
    src: aligned ? input[index].src : -1
  }));
  const trailingNewline = tracked.length > 0 && tracked[tracked.length - 1].text === "";
  const body = trailingNewline ? tracked.slice(0, -1) : tracked;
  const compact = body.filter((line) => !isBlank(line.text));
  if (trailingNewline)
    compact.push(inserted(""));
  if (compact.length > 1 && HEADER_COMMENT.test(compact[0].text)) {
    compact.splice(1, 0, inserted(""));
  }
  return compact;
}

// src/sourcemap.ts
var BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var CHAR_TO_INT = new Map([...BASE64].map((char, index) => [char, index]));
function decodeVlq(text) {
  const values = [];
  let shift = 0;
  let value = 0;
  for (const char of text) {
    const digit = CHAR_TO_INT.get(char);
    if (digit === undefined)
      return values;
    value += (digit & 31) << shift;
    if ((digit & 32) !== 0) {
      shift += 5;
      continue;
    }
    const negative = (value & 1) === 1;
    value >>= 1;
    values.push(negative ? -value : value);
    shift = 0;
    value = 0;
  }
  return values;
}
function encodeVlq(value) {
  let encoded = "";
  let remaining = value < 0 ? -value << 1 | 1 : value << 1;
  do {
    let digit = remaining & 31;
    remaining >>>= 5;
    if (remaining > 0)
      digit |= 32;
    encoded += BASE64[digit];
  } while (remaining > 0);
  return encoded;
}
function decodeMappings(mappings) {
  const lines = [];
  let source = 0;
  let sourceLine = 0;
  let sourceColumn = 0;
  let name = 0;
  for (const group of mappings.split(";")) {
    const segments = [];
    let generatedColumn = 0;
    for (const raw of group.split(",")) {
      if (raw === "")
        continue;
      const values = decodeVlq(raw);
      if (values.length === 0)
        continue;
      generatedColumn += values[0];
      const segment = { generatedColumn };
      if (values.length >= 4) {
        source += values[1];
        sourceLine += values[2];
        sourceColumn += values[3];
        segment.source = source;
        segment.sourceLine = sourceLine;
        segment.sourceColumn = sourceColumn;
      }
      if (values.length >= 5) {
        name += values[4];
        segment.name = name;
      }
      segments.push(segment);
    }
    lines.push(segments);
  }
  return lines;
}
function encodeMappings(lines) {
  let source = 0;
  let sourceLine = 0;
  let sourceColumn = 0;
  let name = 0;
  return lines.map((segments) => {
    let generatedColumn = 0;
    return segments.map((segment) => {
      let encoded = encodeVlq(segment.generatedColumn - generatedColumn);
      generatedColumn = segment.generatedColumn;
      if (segment.source === undefined)
        return encoded;
      encoded += encodeVlq(segment.source - source);
      encoded += encodeVlq(segment.sourceLine - sourceLine);
      encoded += encodeVlq(segment.sourceColumn - sourceColumn);
      source = segment.source;
      sourceLine = segment.sourceLine;
      sourceColumn = segment.sourceColumn;
      if (segment.name === undefined)
        return encoded;
      encoded += encodeVlq(segment.name - name);
      name = segment.name;
      return encoded;
    }).join(",");
  }).join(";");
}
function remapSourceMap(sourceMap, lineMap) {
  let parsed;
  try {
    parsed = JSON.parse(sourceMap);
  } catch {
    return sourceMap;
  }
  if (typeof parsed.mappings !== "string")
    return sourceMap;
  const original = decodeMappings(parsed.mappings);
  const remapped = lineMap.map((line) => line === -1 ? [] : original[line] ?? []);
  return JSON.stringify({ ...parsed, mappings: encodeMappings(remapped) });
}

// src/index.ts
var PLUGIN_NAME = "@gwigz/tstl-bundle-flatten";
function transformLines(code, { skipModules = [], format = true, shake = false }) {
  const original = splitLines(code);
  const flattened = flattenLines(original, skipModules);
  let lines = flattened === original ? original : [...flattened, inserted("")];
  if (shake) {
    lines = shakeLines(lines);
  }
  if (format) {
    lines = formatLines(lines);
  }
  return lines;
}
var plugin = {
  afterEmit(_program, options, emitHost, result) {
    const config = options.luaPlugins?.find((p) => p.name === PLUGIN_NAME);
    for (const file of result) {
      const lines = transformLines(file.code, config ?? {});
      file.code = render(lines);
      emitHost.writeFile(file.outputPath, file.code, false);
      if (options.sourceMap && file.sourceMap !== undefined) {
        file.sourceMap = remapSourceMap(file.sourceMap, lineMap(lines));
        emitHost.writeFile(`${file.outputPath}.map`, file.sourceMap, false);
      }
    }
  }
};
var src_default = plugin;
