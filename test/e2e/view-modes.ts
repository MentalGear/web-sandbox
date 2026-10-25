/**
 * The modes whose guest runs in strict mode's worker and view: strict mode, and sealed mode, which is strict mode with no
 * network (docs/research/24_sealed_mode). A spec of strict mode's guarantees runs in each where it uses no network (research
 * 24, step 3), so sealed mode inherits every one of them; a test that needs `origins` or `fetchBridge` stays strict mode's (a
 * sealed config that names either is refused), and test/e2e/sealed-no-network.spec.ts holds sealed mode's own.
 */
export const VIEW_MODES = ['strict', 'sealed'] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

/** Whether `mode` is one of VIEW_MODES: strict mode's view and worker. */
export const isViewMode = (mode: string): mode is ViewMode => (VIEW_MODES as readonly string[]).includes(mode);
