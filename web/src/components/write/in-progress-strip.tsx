/** One chip of the strip — composed by app/(authed)/create/page.tsx from GET /api/drafts?view=in-progress. */
export type StripChip = {
  ideaId: string;
  /** Idea title / content excerpt / url, already clamped — see post-state.ts's ideaLabel. */
  label: string;
  /** A generation job for this idea is queued or claimed. */
  inFlight: boolean;
  takeCount: number;
  /** The post has a chosen (kept) take. */
  chosen: boolean;
};

/**
 * Top of the Write page (M2.5 plan, task W3): one pill per post in progress,
 * most recently touched first, the one on screen highlighted, a pulsing dot
 * while Claude is writing takes for it, and a × that removes the post from
 * Write (owner direction, 2026-09-22: "devo poter cancellare i post qui
 * sopra") — same look as the recent-searches chips in Find Ideas
 * (components/searches-strip.tsx). Horizontal scroll on a phone (bleeding
 * into the layout's 16px gutters so the row reaches the edges). Purely
 * presentational, like the takes row: clicking a chip reports the idea id
 * upward and the page switches `?ideaId=`; the × reports it through
 * onRemove and the page confirms, calls DELETE /api/drafts?ideaId= and
 * drops the chip (see removePost in app/(authed)/create/page.tsx), with
 * every × disabled while that request is in flight. The row opens with
 * **+ New** (owner, 2026-09-24: "un plus che mi permette di aggiungere del
 * testo in modo manuale"), which toggles the page's new-post composer.
 */
export function InProgressStrip({ chips, currentIdeaId, removingIdeaId, onSelect, onRemove, onNew, newOpen = false }: {
  chips: StripChip[];
  currentIdeaId: string | null;
  /** The post whose removal is in flight, if any — every × is disabled meanwhile. */
  removingIdeaId: string | null;
  onSelect: (ideaId: string) => void;
  /** The × on a chip: remove that post and its takes from Write. */
  onRemove: (ideaId: string) => void;
  /** **+ New**: open (or close) the composer for a post from the owner's own text. */
  onNew?: () => void;
  newOpen?: boolean;
}) {
  if (chips.length === 0 && !onNew) return null;
  return (
    <nav aria-label="Posts in progress" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0">
      {onNew && (
        <button
          type="button"
          onClick={onNew}
          aria-expanded={newOpen}
          data-tip="Write a post from your own text"
          className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium ${
            newOpen ? "border-text-dim bg-surface-2 text-text" : "border-border text-text-dim hover:text-text"
          }`}
        >
          + New
        </button>
      )}
      {chips.map((chip) => {
        const current = chip.ideaId === currentIdeaId;
        const takes = `${chip.takeCount} take${chip.takeCount === 1 ? "" : "s"}`;
        return (
          <span
            key={chip.ideaId}
            className={`inline-flex max-w-56 shrink-0 items-center rounded-full border text-xs ${
              current ? "border-text-dim bg-surface-2 text-text" : "border-border text-text-dim"
            }`}
          >
            <button
              type="button"
              onClick={() => onSelect(chip.ideaId)}
              aria-current={current ? "page" : undefined}
              data-tip={`${takes}${chip.chosen ? " · chosen" : ""}${chip.inFlight ? " · writing…" : ""}`}
              className="flex min-w-0 items-center gap-2 rounded-l-full py-1.5 pl-3 pr-1 hover:text-text"
            >
              {chip.inFlight && (
                <span aria-hidden className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
              )}
              <span className="min-w-0 truncate">{chip.label}</span>
            </button>
            <button
              type="button"
              onClick={() => onRemove(chip.ideaId)}
              disabled={removingIdeaId !== null}
              data-tip="Remove this post from Write"
              aria-label={`Remove post ${chip.label}`}
              className="shrink-0 rounded-r-full py-1.5 pl-1 pr-2.5 text-text-dim hover:text-danger disabled:opacity-50"
            >
              ×
            </button>
          </span>
        );
      })}
    </nav>
  );
}
