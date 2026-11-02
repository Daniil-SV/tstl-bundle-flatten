import { describe, expect, test } from "bun:test";
import { flattenBundle } from "./flatten";
import { formatLua } from "./format";

/**
 * Builds a realistic TSTL luaBundle string matching the actual
 * TypeScriptToLua output format (see: examples/sim-wide-relay in ts-slua).
 */
function tstlBundle(modules: [name: string, body: string][], entry: string) {
  const header = `--[[ Generated with https://github.com/TypeScriptToLua/TypeScriptToLua ]]`;

  const runtime = `local ____modules = {}
local ____moduleCache = {}
local ____originalRequire = require
local function require(file, ...)
    if ____moduleCache[file] then
        return ____moduleCache[file].value
    end
    if ____modules[file] then
        local module = ____modules[file]
        local value = nil
        if (select("#", ...) > 0) then value = module(...) else value = module(file) end
        ____moduleCache[file] = { value = value }
        return value
    else
        if ____originalRequire then
            return ____originalRequire(file)
        else
            error("module '" .. file .. "' not found")
        end
    end
end`;

  const entries = modules.map(([name, body]) => `["${name}"] = function(...) \n${body}\n end,`).join("\n");

  const footer = `local ____entry = require("${entry}", ...)\nreturn ____entry`;

  return `${header}\n\n${runtime}\n____modules = {\n${entries}\n}\n${footer}\n`;
}

/** Runs the full plugin pipeline: flatten then format. */
function transform(code: string, skipModules: string[] = []) {
  return formatLua(flattenBundle(code, skipModules));
}

describe("flattenBundle", () => {
  test("passes through non-bundle code unchanged", () => {
    const code = `--[[ Generated with https://github.com/TypeScriptToLua/TypeScriptToLua ]]
print("hello world")
`;
    expect(flattenBundle(code, [])).toBe(code);
  });

  test("flattens a single-module bundle with value exports", () => {
    const code = tstlBundle(
      [
        [
          "src/constants",
          `local ____exports = {}
____exports.CHANNEL = -1731704569
____exports.TIMEOUT = 30
return ____exports`,
        ],
      ],
      "src/constants",
    );

    expect(flattenBundle(code, [])).toMatchInlineSnapshot(`
"--[[ Generated with https://github.com/TypeScriptToLua/TypeScriptToLua ]]

do
local function ____module_0()
local CHANNEL = -1731704569
local TIMEOUT = 30
end
____module_0()
end
"
`);
  });

  test("hoists a renaming re-export out of the scope its require was in", () => {
    const code = tstlBundle(
      [
        [
          "src/first",
          `local ____exports = {}
function ____exports.value()
    return "a"
end
return ____exports`,
        ],
        [
          "src/mid",
          `local ____exports = {}
do
    local ____first = require("src/first")
    ____exports.alias = ____first.value
end
return ____exports`,
        ],
        [
          "src/entry",
          `local ____exports = {}
local ____mid = require("src/mid")
local alias = ____mid.alias
print(alias())
return ____exports`,
        ],
      ],
      "src/entry",
    );

    const flattened = flattenBundle(code, []);

    expect(flattened).toContain("\nlocal alias = value\n");
    // The forwarding spare line is dropped, and the require it would have read
    // from is gone, so nothing may still name either.
    expect(flattened).not.toContain("____exports");
    expect(flattened).not.toContain("____first");
  });

  test("refuses a namespace import, which has no object left to name", () => {
    const code = tstlBundle(
      [
        [
          "src/first",
          `local ____exports = {}
function ____exports.value()
    return "a"
end
return ____exports`,
        ],
        [
          "src/entry",
          `local ____exports = {}
local all = require("src/first")
print(all.value())
return ____exports`,
        ],
      ],
      "src/entry",
    );

    expect(() => flattenBundle(code, [])).toThrow('cannot flatten a namespace import of "src/first"');
  });

  test("flattens multi-module bundle preserving dependency order", () => {
    const code = tstlBundle(
      [
        [
          "src/math",
          `local ____exports = {}
function ____exports.add(a, b)
    return a + b
end
function ____exports.multiply(a, b)
    return a * b
end
return ____exports`,
        ],
        [
          "src/main",
          `local ____math = require("src/math")
local add = ____math.add
local multiply = ____math.multiply
print(add(1, multiply(2, 3)))`,
        ],
      ],
      "src/main",
    );

    expect(flattenBundle(code, [])).toMatchInlineSnapshot(`
"--[[ Generated with https://github.com/TypeScriptToLua/TypeScriptToLua ]]

local add, multiply
do
local function ____module_0()
function add(a, b)
    return a + b
end
function multiply(a, b)
    return a * b
end
end
____module_0()
end

do
local function ____module_1()
print(add(1, multiply(2, 3)))
end
____module_1()
end
"
`);
  });

  test("aliases renamed imports instead of removing them", () => {
    const code = tstlBundle(
      [
        [
          "src/utils",
          `local ____exports = {}
function ____exports.create()
    return {}
end
return ____exports`,
        ],
        [
          "src/main",
          `local ____utils = require("src/utils")
local makeNew = ____utils.create
makeNew()`,
        ],
      ],
      "src/main",
    );

    expect(flattenBundle(code, [])).toMatchInlineSnapshot(`
"--[[ Generated with https://github.com/TypeScriptToLua/TypeScriptToLua ]]

local create
do
local function ____module_0()
function create()
    return {}
end
end
____module_0()
end

do
local function ____module_1()
local makeNew = create
makeNew()
end
____module_1()
end
"
`);
  });

  test("skips modules listed in skipModules", () => {
    const code = tstlBundle(
      [
        [
          "lualib_bundle",
          `local ____exports = {}
function ____exports.__TS__ArrayPush(arr, ...)
    local items = {...}
    for ____, item in ipairs(items) do
        arr[#arr + 1] = item
    end
    return #arr
end
return ____exports`,
        ],
        [
          "src/main",
          `local ____lualib = require("lualib_bundle")
local __TS__ArrayPush = ____lualib.__TS__ArrayPush
local list = {}
__TS__ArrayPush(list, "hello")`,
        ],
      ],
      "src/main",
    );

    expect(flattenBundle(code, ["lualib_bundle"])).toMatchInlineSnapshot(`
"--[[ Generated with https://github.com/TypeScriptToLua/TypeScriptToLua ]]

do
local function ____module_0()
local list = {}
__TS__ArrayPush(list, "hello")
end
____module_0()
end
"
`);
  });

  test("handles ____exports internal references", () => {
    const code = tstlBundle(
      [
        [
          "src/config",
          `local ____exports = {}
____exports.DEFAULT_TIMEOUT = 30
____exports.MAX_RETRIES = 3
function ____exports.getConfig()
    return {timeout = ____exports.DEFAULT_TIMEOUT, retries = ____exports.MAX_RETRIES}
end
return ____exports`,
        ],
      ],
      "src/config",
    );

    expect(flattenBundle(code, [])).toMatchInlineSnapshot(`
"--[[ Generated with https://github.com/TypeScriptToLua/TypeScriptToLua ]]

do
local function ____module_0()
local DEFAULT_TIMEOUT = 30
local MAX_RETRIES = 3
local function getConfig()
    return {timeout = DEFAULT_TIMEOUT, retries = MAX_RETRIES}
end
end
____module_0()
end
"
`);
  });

  test("strips return with table constructor", () => {
    const code = tstlBundle(
      [
        [
          "src/types",
          `local ____exports = {}
____exports.VERSION = "1.0.0"
return {VERSION = ____exports.VERSION}`,
        ],
      ],
      "src/types",
    );

    expect(flattenBundle(code, [])).toMatchInlineSnapshot(`
"--[[ Generated with https://github.com/TypeScriptToLua/TypeScriptToLua ]]

do
local function ____module_0()
local VERSION = "1.0.0"
end
____module_0()
end
"
`);
  });

  test("strips imports the return left as the body's last line", () => {
    // `return ____exports` goes before the imports do, so a re-export module
    // can end up with a require or destructure as its final line. The regexes
    // this replaced were anchored on a trailing newline and left those behind,
    // still referring to a `____mod` that had just been deleted.
    const code = tstlBundle(
      [
        [
          "src/utils",
          `local ____exports = {}
function ____exports.create()
    return {}
end
return ____exports`,
        ],
        [
          "src/index",
          `local ____exports = {}
local ____utils = require("src/utils")
local create = ____utils.create
local makeNew = ____utils.create
return ____exports`,
        ],
        ["src/main", `local ____index = require("src/index")\nmakeNew()`],
      ],
      "src/main",
    );

    expect(flattenBundle(code, [])).toMatchInlineSnapshot(`
      "--[[ Generated with https://github.com/TypeScriptToLua/TypeScriptToLua ]]

      local create
      do
      local function ____module_0()
      function create()
          return {}
      end
      end
      ____module_0()
      end

      do
      local function ____module_1()
      local makeNew = create
      end
      ____module_1()
      end

      do
      local function ____module_2()
      makeNew()
      end
      ____module_2()
      end
      "
    `);
  });

  test("strips do/end scopes that only wrapped a require + destructure", () => {
    // TSTL wraps side-effect-only or hoisted imports in a `do ... end` scope.
    // After flatten strips the require line and the same-name destructure,
    // the block body is empty and the scope should collapse away.
    const code = tstlBundle(
      [
        [
          "src/shared",
          `local ____exports = {}
function ____exports.helper()
    return 1
end
return ____exports`,
        ],
        [
          "src/main",
          `do
    local ____shared = require("src/shared")
    local helper = ____shared.helper
end
print("hi")`,
        ],
      ],
      "src/main",
    );

    expect(flattenBundle(code, [])).toMatchInlineSnapshot(`
"--[[ Generated with https://github.com/TypeScriptToLua/TypeScriptToLua ]]

local helper
do
local function ____module_0()
function helper()
    return 1
end
end
____module_0()
end

do
local function ____module_1()
print("hi")
end
____module_1()
end
"
`);
  });

  test("leaves non-empty do/end scopes untouched", () => {
    const code = tstlBundle(
      [
        [
          "src/main",
          `do
    local x = 1
    print(x)
end`,
        ],
      ],
      "src/main",
    );

    expect(flattenBundle(code, [])).toMatchInlineSnapshot(`
"--[[ Generated with https://github.com/TypeScriptToLua/TypeScriptToLua ]]

do
local function ____module_0()
do
    local x = 1
    print(x)
end
end
____module_0()
end
"
`);
  });
});

describe("full pipeline (flatten + format)", () => {
  test("transforms a realistic multi-module bundle", () => {
    const code = tstlBundle(
      [
        [
          "src/shared",
          `local ____exports = {}
____exports.PRIVATE_CHANNEL = -1731704569
____exports.TIMEOUT = 30
function ____exports.sign(payload)
    local bucket = ll.GetUnixTime() // 2
    return string.sub(ll.MD5String(tostring(bucket) .. "|" .. payload, -1977872753), 1, 8) .. "|" .. payload
end
return ____exports`,
        ],
        [
          "src/main",
          `local ____shared = require("src/shared")
local PRIVATE_CHANNEL = ____shared.PRIVATE_CHANNEL
local sign = ____shared.sign
local owner = ll.GetOwner()
local function onListen(channel, _name, id, text)
    if channel ~= PRIVATE_CHANNEL then
        return
    end
    if ll.GetOwnerKey(id) ~= owner then
        return
    end
    ll.OwnerSay(text)
end
LLEvents:on("listen", onListen)
ll.Listen(PRIVATE_CHANNEL, "", uuid.create(""), "")`,
        ],
      ],
      "src/main",
    );

    expect(transform(code)).toMatchInlineSnapshot(`
"--[[ Generated with https://github.com/TypeScriptToLua/TypeScriptToLua ]]

local PRIVATE_CHANNEL, sign

do

local function ____module_0()
PRIVATE_CHANNEL = -1731704569

local TIMEOUT = 30

function sign(payload)
    local bucket = ll.GetUnixTime() // 2

    return string.sub(ll.MD5String(tostring(bucket) .. "|" .. payload, -1977872753), 1, 8) .. "|" .. payload
end
end

____module_0()
end

do

local function ____module_1()
local owner = ll.GetOwner()

local function onListen(channel, _name, id, text)
    if channel ~= PRIVATE_CHANNEL then
        return
    end

    if ll.GetOwnerKey(id) ~= owner then
        return
    end

    ll.OwnerSay(text)
end

LLEvents:on("listen", onListen)
ll.Listen(PRIVATE_CHANNEL, "", uuid.create(""), "")
end

____module_1()
end

"
`);
  });

  test("transforms bundle with three modules in dependency chain", () => {
    const code = tstlBundle(
      [
        [
          "src/constants",
          `local ____exports = {}
____exports.MAX_AGENTS = 100
____exports.SCAN_INTERVAL = 5.0
return ____exports`,
        ],
        [
          "src/scanner",
          `local ____exports = {}
local ____constants = require("src/constants")
local MAX_AGENTS = ____constants.MAX_AGENTS
local SCAN_INTERVAL = ____constants.SCAN_INTERVAL
function ____exports.scan()
    local agents = ll.GetAgentList(AGENT_LIST_REGION, {})
    if #agents > MAX_AGENTS then
        return
    end
    for ____, agent in ipairs(agents) do
        ll.RegionSayTo(agent, 0, "ping")
    end
end
return ____exports`,
        ],
        [
          "src/main",
          `local ____scanner = require("src/scanner")
local scan = ____scanner.scan
local ____constants = require("src/constants")
local SCAN_INTERVAL = ____constants.SCAN_INTERVAL
ll.SetTimerEvent(SCAN_INTERVAL)
LLEvents:on("timer", scan)`,
        ],
      ],
      "src/main",
    );

    expect(transform(code)).toMatchInlineSnapshot(`
"--[[ Generated with https://github.com/TypeScriptToLua/TypeScriptToLua ]]

local MAX_AGENTS, SCAN_INTERVAL, scan

do

local function ____module_0()
MAX_AGENTS = 100
SCAN_INTERVAL = 5.0
end

____module_0()
end

do

local function ____module_1()
function scan()
    local agents = ll.GetAgentList(AGENT_LIST_REGION, {})

    if #agents > MAX_AGENTS then
        return
    end

    for ____, agent in ipairs(agents) do
        ll.RegionSayTo(agent, 0, "ping")
    end
end
end

____module_1()
end

do

local function ____module_2()
ll.SetTimerEvent(SCAN_INTERVAL)
LLEvents:on("timer", scan)
end

____module_2()
end

"
`);
  });

  test("transforms bundle with skipModules excluding lualib", () => {
    const code = tstlBundle(
      [
        [
          "lualib_bundle",
          `local ____exports = {}
function ____exports.__TS__StringIncludes(self, searchString, position)
    if position == nil then position = 1 end
    return string.find(self, searchString, position, true) ~= nil
end
return ____exports`,
        ],
        [
          "src/main",
          `local ____lualib = require("lualib_bundle")
local __TS__StringIncludes = ____lualib.__TS__StringIncludes
local message = "hello world"
if __TS__StringIncludes(message, "hello") then
    print("found")
end`,
        ],
      ],
      "src/main",
    );

    expect(transform(code, ["lualib_bundle"])).toMatchInlineSnapshot(`
"--[[ Generated with https://github.com/TypeScriptToLua/TypeScriptToLua ]]

do

local function ____module_0()
local message = "hello world"

if __TS__StringIncludes(message, "hello") then
    print("found")
end
end

____module_0()
end

"
`);
  });
});
