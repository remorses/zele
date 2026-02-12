// Type patch for @opentui/react.
//
// The installed package's .d.ts re-exports are missing the hooks entrypoint,
// so TS doesn't see `useTerminalDimensions` even though runtime exports it.
// Keep this minimal and local to avoid sprinkling type assertions in code.

declare module '@opentui/react' {
  export function useTerminalDimensions(): { width: number; height: number }
}
