// Minimal ambient type shims for editing Supabase Edge Function source in a
// plain TypeScript-aware editor (no Deno extension required).
//
// These are NOT used at runtime - Deno provides its own real `Deno` global
// and resolves `https://...` URL imports natively when these functions
// actually run. This file exists purely so a standard editor's TypeScript
// language service (scoped by supabase/functions/tsconfig.json) doesn't
// report false "Cannot find name 'Deno'" / "Cannot find module" errors
// while editing. It intentionally only covers the handful of APIs this
// project actually calls - it is not a complete Deno type definition.

declare namespace Deno {
  function serve(handler: (request: Request) => Response | Promise<Response>): void;

  namespace env {
    function get(key: string): string | undefined;
  }

  function test(name: string, fn: () => void | Promise<void>): void;
}

// Supabase Edge Functions import npm packages by URL (esm.sh) and Deno's own
// standard library (deno.land) - neither is resolvable by a Node-oriented
// TypeScript project, so both are declared here as untyped (`any`) modules
// purely to silence editor-time "Cannot find module" noise. Deno itself
// resolves and type-checks these for real at runtime/via `deno check`.
declare module 'https://esm.sh/*';
declare module 'https://deno.land/*';
