import type { Plugin } from "typescript-to-lua";

import { foldProgram, type InjectGlobalValue } from "./fold";
import { DEFAULT_REGISTER_BUDGET, LUAU_REGISTER_LIMIT, type RegisterUsage, formatRegisterReport } from "./budget";
import { flattenWithUsage } from "./flatten";
import { formatLines } from "./format";
import { type Line, inserted, lineMap, render, splitLines } from "./lines";
import { shakeProgram } from "./shake";
import { remapSourceMap } from "./sourcemap";

export interface GlobalValueConfig {
  value?: unknown;
  env?: string;
  envJson?: string;
  env_json?: string;
  defaultValue?: unknown;
  default_value?: unknown;
}

export type GlobalValueInput = GlobalValueConfig & {
  identifier: string;
};

export interface PluginConfig {
  name: string;
  skipModules?: string[];
  format?: boolean;
  /** Shake unused TypeScript declarations before TSTL emits Lua. */
  shake?: boolean;
  /** Also remove unused class methods and accessors (requires `shake`). */
  shakeClassFunctions?: boolean;
  /** Fold constant expressions before shaking (defaults to true with `shake`). */
  computeExpressions?: boolean;
  /** Alias for `computeExpressions`, matching darklua's rule name. */
  computeExpression?: boolean;
  /** Compile-time globals, either plain values or `{ value, env, envJson, defaultValue }`. */
  globals?: Record<string, unknown>;
  /** Alias for `globals`. */
  injectGlobals?: Record<string, unknown>;
  /** darklua-style list of globals to inject. */
  injectGlobalValues?: GlobalValueInput[];
  /** Aliases kept for compatibility with older configs. */
  shakeClasses?: boolean;
  classFunctions?: boolean;
  removeClassFunctions?: boolean;
  shakeClassMembers?: boolean;
  /** Wrap each module in its own function so its locals leave the root scope (default true). */
  scopeModules?: boolean;
  /** Root locals the flattener aims for; the coldest bindings move into a table (default 150). */
  registerBudget?: number | false;
  /** Root locals that count as a failure when reporting (default 200). */
  registerLimit?: number | false;
  /** Warn when the flattened bundle does not fit the register limit (default "warn"). */
  registerReport?: "warn" | "off";
  /**
   * Names that host Lua must be able to call as globals (for example a `tick`
   * the server invokes). Their module-level declarations stop being `local`, and
   * shared bindings are copied to the global table at root scope.
   */
  rootGlobals?: string[];
}

interface ResolvedConfig {
  skipModules: string[];
  format: boolean;
  shake: boolean;
  shakeClassFunctions: boolean;
  computeExpressions: boolean;
  globals: InjectGlobalValue[];
  scopeModules: boolean;
  registerBudget: number | false;
  registerLimit: number | false;
  registerReport: "warn" | "off";
  rootGlobals: string[];
}

const PLUGIN_NAME = "@gwigz/tstl-bundle-flatten";

function resolveGlobals(config: Partial<PluginConfig>): InjectGlobalValue[] {
  const globals: InjectGlobalValue[] = [];
  const values = { ...config.globals, ...config.injectGlobals };

  for (const [identifier, value] of Object.entries(values)) {
    globals.push(isGlobalValueConfig(value) ? { identifier, ...globalFields(value) } : { identifier, value });
  }

  for (const spec of config.injectGlobalValues ?? []) {
    globals.push({ identifier: spec.identifier, ...globalFields(spec) });
  }

  return globals;
}

function isGlobalValueConfig(value: unknown): value is GlobalValueConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  return (
    "value" in value ||
    "env" in value ||
    "envJson" in value ||
    "env_json" in value ||
    "defaultValue" in value ||
    "default_value" in value
  );
}

/**
 * Accepts both the camelCase names used by this plugin and darklua's
 * snake_case spelling (`env_json`, `default_value`).
 */
function globalFields(spec: GlobalValueConfig): Omit<InjectGlobalValue, "identifier"> {
  const envJson = spec.envJson ?? spec.env_json;
  const defaultValue = spec.defaultValue ?? spec.default_value;

  return {
    ...(spec.value === undefined ? {} : { value: spec.value }),
    ...(spec.env === undefined ? {} : { env: spec.env }),
    ...(envJson === undefined ? {} : { envJson }),
    ...(defaultValue === undefined ? {} : { defaultValue }),
  };
}

function resolveConfig(config: Partial<PluginConfig>): ResolvedConfig {
  const classFunctions =
    config.shakeClassFunctions ??
    config.shakeClasses ??
    config.classFunctions ??
    config.removeClassFunctions ??
    config.shakeClassMembers ??
    false;

  const shake = config.shake ?? false;
  const globals = resolveGlobals(config);
  const computeExpressions = config.computeExpressions ?? config.computeExpression ?? (shake || globals.length > 0);

  return {
    skipModules: config.skipModules ?? [],
    format: config.format ?? true,
    shake,
    shakeClassFunctions: classFunctions === true,
    computeExpressions: computeExpressions === true,
    globals,
    scopeModules: config.scopeModules ?? true,
    registerBudget: config.registerBudget ?? DEFAULT_REGISTER_BUDGET,
    registerLimit: config.registerLimit ?? LUAU_REGISTER_LIMIT,
    registerReport: config.registerReport ?? "warn",
    rootGlobals: config.rootGlobals ?? [],
  };
}

export interface TransformOptions {
  skipModules?: string[];
  format?: boolean;
  scopeModules?: boolean;
  registerBudget?: number | false;
  registerLimit?: number | false;
  registerReport?: "warn" | "off";
  rootGlobals?: string[];
  /** Called with the flatten plan's register numbers, when the code was a bundle. */
  onUsage?: (usage: RegisterUsage) => void;
}

/**
 * Runs the emit transforms, tracking which bundle line each output line
 * came from so the source map can be rewritten to match.
 */
export function transformLines(
  code: string,
  {
    skipModules = [],
    format = true,
    scopeModules,
    registerBudget,
    registerLimit,
    rootGlobals,
    onUsage,
  }: TransformOptions = {},
): Line[] {
  const original = splitLines(code);

  const { lines: flattened, usage } = flattenWithUsage(original, {
    skipModules,
    scopeModules,
    registerBudget,
    registerLimit,
    rootGlobals,
  });

  // Flattening ends the file with a newline; code that was not a bundle is
  // passed through untouched, so it keeps whatever ending it already had.
  let lines = flattened === original ? original : [...flattened, inserted("")];

  if (format) {
    lines = formatLines(lines);
  }

  if (usage !== null && onUsage !== undefined) onUsage(usage);

  return lines;
}

/**
 * Builds a plugin instance for the given inline config.
 *
 * TSTL calls a default-exported function with the plugin's config object, so
 * the tree shaker knows the options before `beforeTransform` runs.
 */
export function createPlugin(config: Partial<PluginConfig> = {}): Plugin {
  const resolved = resolveConfig(config);

  return {
    beforeTransform(program) {
      // Fold first: tree shaking has to see the already-removed dead branches
      // before it decides which declarations are reachable.
      if (resolved.computeExpressions || resolved.globals.length > 0) {
        foldProgram(program, {
          globals: resolved.globals,
          computeExpressions: resolved.computeExpressions,
        });
      }

      if (!resolved.shake) return;

      shakeProgram(program, { shakeClassFunctions: resolved.shakeClassFunctions });
    },

    afterEmit(_program, options, emitHost, result) {
      // TSTL passes plugins their own inline option object, but tests and
      // direct callers may use the exported plugin without that wrapper.
      const pluginConfig = options.luaPlugins?.find((plugin) => "name" in plugin && plugin.name === PLUGIN_NAME);

      const transform = pluginConfig
        ? {
            skipModules: pluginConfig.skipModules ?? resolved.skipModules,
            format: pluginConfig.format ?? resolved.format,
            scopeModules: pluginConfig.scopeModules ?? resolved.scopeModules,
            registerBudget: pluginConfig.registerBudget ?? resolved.registerBudget,
            registerLimit: pluginConfig.registerLimit ?? resolved.registerLimit,
            registerReport: pluginConfig.registerReport ?? resolved.registerReport,
            rootGlobals: pluginConfig.rootGlobals ?? resolved.rootGlobals,
          }
        : resolved;

      for (const file of result) {
        const lines = transformLines(file.code, {
          ...transform,
          onUsage: (usage) => {
            if (transform.registerReport === "off") return;

            const message = formatRegisterReport(usage);

            if (message !== null) console.warn(message);
          },
        });

        file.code = render(lines);

        emitHost.writeFile(file.outputPath, file.code, false);

        // TSTL wrote the map before plugins ran, so it still describes the
        // unflattened bundle. Rewrite it to match what we just emitted, but
        // only where TSTL wrote one, or we leave a stray `.map` behind.
        if (options.sourceMap && file.sourceMap !== undefined) {
          file.sourceMap = remapSourceMap(file.sourceMap, lineMap(lines));

          emitHost.writeFile(`${file.outputPath}.map`, file.sourceMap, false);
        }
      }
    },
  };
}

// TSTL resolves the default export as a factory. `.afterEmit` is attached too
// so the hook can still be called on the exported plugin directly.
const plugin = Object.assign(createPlugin, { afterEmit: createPlugin().afterEmit });

export { shakeProgram } from "./shake";
export default plugin;
