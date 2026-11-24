/**
 * Product naming lives here so a rename touches one file (plus package.json and docs).
 */
export const PRODUCT_NAME = "TraceWarp";
export const CLI_NAME = "tracewarp";
/** Working directory folder that holds traces and replay runs. */
export const HOME_DIR_NAME = ".tracewarp";
/** Config file looked up in the working directory. */
export const CONFIG_FILE_NAME = "tracewarp.yaml";
/** Environment variable that overrides the trace directory. */
export const DIR_ENV_VAR = "TRACEWARP_DIR";
/** API key used for replays. Falls back to ANTHROPIC_API_KEY. */
export const API_KEY_ENV_VAR = "TRACEWARP_ANTHROPIC_API_KEY";
/** Where replays and the recording proxy send requests. Defaults to the public Anthropic API. */
export const UPSTREAM_ENV_VAR = "TRACEWARP_UPSTREAM";
export const DEFAULT_UPSTREAM = "https://api.anthropic.com";
