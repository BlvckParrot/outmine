// The last line between a render that throws and a blank page.
//
// Worth having on this site in particular: some of what React renders here comes from
// localStorage, which outlives the reload that would otherwise be the fix - so a single
// bad stored value used to mean a white screen that stayed white.
import { Component, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { failed: boolean };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("outmine: render failed", error);
  }

  /** Clears what this browser remembers and reloads. Offered rather than done
   *  automatically: wiping someone's edit tokens is not a thing to do on a guess, and
   *  the tokens are the only proof a listing is theirs. */
  #reset = () => {
    try {
      localStorage.clear();
    } catch {
      /* storage disabled; the reload is still worth trying */
    }
    location.reload();
  };

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="mx-auto max-w-md p-8 text-center font-sans text-sm">
        <h1 className="text-lg font-bold">Something broke on this page.</h1>
        <p className="mt-2 text-muted-foreground">
          Mining has stopped. Reloading usually fixes it; if it does not, clearing what this
          browser has stored will — but that also forgets the edit tokens for any listing you
          created here, so copy them somewhere first if you still need them.
        </p>
        <div className="mt-4 flex justify-center gap-2 text-xs">
          <button
            onClick={() => location.reload()}
            className="cursor-pointer rounded-full bg-primary px-4 py-1.5 font-bold text-primary-foreground"
          >
            reload
          </button>
          <button
            onClick={this.#reset}
            className="cursor-pointer rounded-full border border-border px-4 py-1.5 font-medium"
          >
            clear storage and reload
          </button>
        </div>
      </div>
    );
  }
}
