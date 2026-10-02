/**
 * User-facing product identity. Rename the project by editing this object,
 * `package.json`, and the dashboard wordmark in `public/index.html`.
 */
export const brand = {
  /** Display name in help text, logs, and the dashboard. */
  name: "Session Analytics",
  /** Installed command name. */
  command: "session-analytics",
} as const;

/**
 * Machine-facing identifiers stay neutral and do not follow the brand, so a
 * rename never breaks a running dashboard, saved settings, or agent callers.
 */
export const serviceId = "session-analytics";
