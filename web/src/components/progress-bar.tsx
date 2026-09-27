// The indeterminate bar's keyframes — hoisted and deduped by React 19
// (`href` + `precedence`), so the bar owns its one bit of CSS instead of
// reaching into globals.css.
const BAR_CSS = "@keyframes postecho-progress{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}";

/** A thin bar that keeps moving while something runs: Claude writing, a search (2026-09-27: "l'animazione della search la lascerei sempre"). */
export function ProgressBar() {
  return (
    <>
      <style href="postecho-progress-bar" precedence="default">{BAR_CSS}</style>
      <div aria-hidden className="h-1 w-full overflow-hidden rounded-full bg-surface-2">
        <div className="h-full w-1/3 rounded-full bg-accent animate-[postecho-progress_1.4s_ease-in-out_infinite] motion-reduce:animate-pulse" />
      </div>
    </>
  );
}
