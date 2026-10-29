/**
 * Minimal declarations for Bun-specific syntax that appears in server source
 * imported by the app (e.g. `if (import.meta.main)` in the Elysia entry).
 *
 * Node/Nuxt already provide the standard `ImportMeta`; this only adds the
 * `main` flag Bun defines. Intentionally does NOT touch `fetch` or any
 * global Bun namespace, so the app keeps the standard fetch interface
 * (no `preconnect` requirement for the Eden custom fetcher).
 */

interface ImportMeta {
  /**
   * Whether the current module is the entry point of the running process
   * (Bun extension; always `false` under Node/Nuxt).
   */
  readonly main: boolean;
}
