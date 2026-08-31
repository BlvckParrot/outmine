// A router in a dozen lines.
//
// Six static paths and one parameterised one do not justify a dependency. The server
// serves index.html for anything it does not recognise, so a direct load of /about
// arrives here the same as a click does.
import { useEffect, useState } from "react";

export function usePath(): string {
  const [path, setPath] = useState(() => location.pathname);
  useEffect(() => {
    const sync = () => setPath(location.pathname);
    addEventListener("popstate", sync);
    return () => removeEventListener("popstate", sync);
  }, []);
  return path;
}

/** pushState does not fire popstate - that event is for the back button - so the one
 *  subscription above is driven by hand here. */
function navigate(to: string) {
  if (location.pathname === to) return;
  history.pushState(null, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
  scrollTo(0, 0);
}

/** An in-app link. A plain <a> would reload the page, which drops the WebSocket and
 *  stops mining; modified clicks still open a new tab, as they should. */
export function linkProps(to: string) {
  return {
    href: to,
    onClick: (e: React.MouseEvent) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      navigate(to);
    },
  };
}
