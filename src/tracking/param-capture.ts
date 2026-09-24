import { createHash } from 'node:crypto';
import type { ToolParamCapture } from '../context/types.js';
import type { Logger } from '../utils/logger.js';
import { EVENT_PROPERTY_KEYS as K } from './constants.js';

const PARAM_KEYS_MAX = 32;
const PARAM_SHAPE_MAX = 1024;
const DERIVED_PARAM_MAX = 8;
const DERIVED_VALUE_MAX = 256;
const TRUNCATION_MARKER = '…';
const SAFE_IDENTIFIER = /^[A-Za-z0-9_.:\-/]{1,64}$/;

/** Validated tool-level capture policy. @internal */
export interface ResolvedToolParamCapture {
  routeKey?: string;
  derive?: (
    params: Record<string, unknown>,
  ) => Record<string, string | number | boolean>;
  never: readonly string[];
}

/** Result of validating a tool's optional capture declaration. @internal */
export interface ToolParamCaptureResolution {
  disabled: boolean;
  policy?: ResolvedToolParamCapture;
  warnings: readonly string[];
}

/**
 * Validate capture metadata without throwing. Invalid *fields* are ignored so
 * default shape capture still runs. Only a non-object `paramCapture` disables
 * capture for the tool.
 *
 * @internal
 */
export function resolveToolParamCapture(
  value: unknown,
): ToolParamCaptureResolution {
  if (value == null) return { disabled: false, warnings: [] };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return {
      disabled: true,
      warnings: ['paramCapture must be an object'],
    };
  }

  const input = value as ToolParamCapture;
  const warnings: string[] = [];
  const policy: ResolvedToolParamCapture = { never: [] };

  if (input.routeKey != null) {
    if (typeof input.routeKey === 'string') {
      policy.routeKey = input.routeKey;
    } else {
      warnings.push('paramCapture.routeKey must be a string; it was ignored');
    }
  }
  if (input.derive != null) {
    if (typeof input.derive === 'function') {
      policy.derive = input.derive;
    } else {
      warnings.push('paramCapture.derive must be a function; it was ignored');
    }
  }
  if (input.never != null) {
    if (Array.isArray(input.never)) {
      policy.never = input.never.filter(
        (key): key is string => typeof key === 'string',
      );
      if (policy.never.length !== input.never.length) {
        warnings.push('non-string entries in paramCapture.never were ignored');
      }
    } else {
      warnings.push('paramCapture.never must be an array of strings; it was ignored');
    }
  }

  return { disabled: false, policy, warnings };
}

/** Capture properties computed for one dispatched tool call. @internal */
export interface CapturedParamProperties {
  tier1: Record<string, unknown>;
  tier2: Record<string, unknown>;
}

/**
 * Derive bounded parameter metadata. No exception from parameter inspection or
 * a consumer callback is allowed to escape into the instrumented handler.
 *
 * @internal
 */
export function captureParamProperties(
  params: Record<string, unknown>,
  options: {
    shape: boolean;
    neverKeys: readonly string[];
    policy?: ResolvedToolParamCapture;
    logger: Logger;
    toolName: string;
  },
): CapturedParamProperties {
  const excluded = new Set([
    ...options.neverKeys,
    ...(options.policy?.never ?? []),
  ]);

  return {
    tier1: options.shape
      ? deriveShapeProperties(params, excluded, options.policy?.routeKey)
      : {},
    tier2: deriveMetadataProperties(
      params,
      excluded,
      options.policy?.derive,
      options.logger,
      options.toolName,
    ),
  };
}

function deriveShapeProperties(
  params: Record<string, unknown>,
  excluded: ReadonlySet<string>,
  routeKey: string | undefined,
): Record<string, unknown> {
  const suppliedKeys = Object.keys(params).filter(
    (key) => !excluded.has(key) && params[key] !== undefined,
  );
  const boundedKeys = suppliedKeys
    .filter((key) => SAFE_IDENTIFIER.test(key))
    .sort();

  const tokens = boundedKeys.map((key) => `${key}:${shapeOf(params[key])}`);
  const routeValue = routeKey == null ? undefined : params[routeKey];
  if (routeKey != null && !excluded.has(routeKey) && isSafeRouteValue(routeValue)) {
    tokens.unshift(`route=${formatRouteValue(routeValue)}`);
  }

  const shape = truncateTokens(tokens, PARAM_SHAPE_MAX);

  return {
    [K.paramKeys]: boundedKeys.slice(0, PARAM_KEYS_MAX),
    [K.paramCount]: suppliedKeys.length,
    [K.paramShape]: shape,
    [K.paramFingerprint]: createHash('sha256')
      .update(shape)
      .digest('hex')
      .slice(0, 12),
  };
}

function isSafeRouteValue(
  value: unknown,
): value is string | number | boolean {
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' && SAFE_IDENTIFIER.test(value);
}

function formatRouteValue(value: string | number | boolean): string {
  return String(value);
}

function shapeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `arr[${value.length}]`;

  switch (typeof value) {
    case 'boolean':
      return 'bool';
    case 'number':
      return 'num';
    case 'string':
      if (value.length === 0) return 'str[0]';
      if (value.length <= 32) return 'str[1-32]';
      if (value.length <= 256) return 'str[33-256]';
      return 'str[257+]';
    case 'object':
      return `obj[${Object.keys(value).length}]`;
    default:
      return typeof value;
  }
}

function truncateTokens(tokens: readonly string[], max: number): string {
  const joined = tokens.join(';');
  if (joined.length <= max) return joined;

  const kept: string[] = [];
  for (const token of tokens) {
    const candidate = [...kept, token].join(';');
    if (candidate.length + TRUNCATION_MARKER.length > max) break;
    kept.push(token);
  }
  return `${kept.join(';')}${TRUNCATION_MARKER}`;
}

function deriveMetadataProperties(
  params: Record<string, unknown>,
  excluded: ReadonlySet<string>,
  derive: ResolvedToolParamCapture['derive'],
  logger: Logger,
  toolName: string,
): Record<string, unknown> {
  if (derive == null) return {};

  let values: unknown;
  try {
    values = derive(params);
  } catch {
    logger.debug(
      `AmplitudeMCPAnalytics: paramCapture.derive for '${toolName}' threw; derived parameter properties were omitted.`,
    );
    return {};
  }
  if (values == null || typeof values !== 'object' || Array.isArray(values)) {
    return {};
  }

  const properties: Record<string, unknown> = {};
  for (const key of Object.keys(values).sort()) {
    if (Object.keys(properties).length >= DERIVED_PARAM_MAX) break;
    if (excluded.has(key) || !SAFE_IDENTIFIER.test(key)) continue;

    const value = (values as Record<string, unknown>)[key];
    if (!isSafeDerivedValue(value)) continue;
    properties[`[MCP] Param: ${key}`] = value;
  }
  return properties;
}

function isSafeDerivedValue(
  value: unknown,
): value is string | number | boolean {
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return (
    typeof value === 'string' &&
    value.length <= DERIVED_VALUE_MAX &&
    !/[@\n\r"']/.test(value)
  );
}
