import {
  Children,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useState,
  type AnchorHTMLAttributes,
  type ReactNode,
} from "react";
import { navigateTo, subscribeToNavigation } from "./history";

// A small same-origin history router. The application needs only static paths,
// named path parameters, nested layouts, and links; no data-router framework.
const LocationContext = createContext(window.location.pathname);
const ParametersContext = createContext<Record<string, string>>({});
const OutletContext = createContext<ReactNode>(null);

export function BrowserRouter({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(
    () => subscribeToNavigation(() => setPath(window.location.pathname)),
    [],
  );
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [path]);
  return (
    <LocationContext.Provider value={path}>{children}</LocationContext.Provider>
  );
}

export function useNavigate() {
  return useCallback(navigateTo, []);
}

export function Navigate({
  to,
  replace = false,
}: {
  to: string;
  replace?: boolean;
}) {
  const navigate = useNavigate();
  useEffect(() => {
    navigate(to, { replace });
  }, [navigate, to, replace]);
  return null;
}

export function Link({
  to,
  onClick,
  children,
  ...props
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { to: string }) {
  const navigate = useNavigate();
  return (
    <a
      {...props}
      href={to}
      onClick={(event) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          props.target === "_blank" ||
          props.download
        )
          return;
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

export function NavLink({
  end = false,
  className,
  to,
  ...props
}: Parameters<typeof Link>[0] & { end?: boolean }) {
  const path = useContext(LocationContext);
  const active = end ? path === to : path === to || path.startsWith(`${to}/`);
  return (
    <Link
      {...props}
      to={to}
      className={[className, active ? "active" : ""].filter(Boolean).join(" ")}
      aria-current={active ? "page" : undefined}
    />
  );
}

type RouteProps = {
  path?: string;
  index?: boolean;
  element: ReactNode;
  children?: ReactNode;
};
type Match = { elements: ReactNode[]; parameters: Record<string, string> };
export function Route(_props: RouteProps) {
  return null;
}
export function Outlet() {
  return <>{useContext(OutletContext)}</>;
}
export function useParams() {
  return useContext(ParametersContext);
}

function matchRoutes(
  children: ReactNode,
  segments: string[],
  offset = 0,
  parameters: Record<string, string> = {},
): Match | undefined {
  for (const child of Children.toArray(children)) {
    if (!isValidElement<RouteProps>(child)) continue;
    const { path, index, element, children: nested } = child.props;
    if (path === "*") return { elements: [element], parameters };
    const parts = (path || "").split("/").filter(Boolean);
    let matched = offset + parts.length <= segments.length;
    const nextParameters = { ...parameters };
    for (let i = 0; matched && i < parts.length; i++) {
      if (parts[i].startsWith(":")) {
        try {
          nextParameters[parts[i].slice(1)] = decodeURIComponent(
            segments[offset + i],
          );
        } catch {
          matched = false;
        }
      } else if (parts[i] !== segments[offset + i]) matched = false;
    }
    if (!matched) continue;
    const consumed = offset + parts.length;
    if (nested) {
      const result = matchRoutes(nested, segments, consumed, nextParameters);
      if (result)
        return {
          elements: [element, ...result.elements],
          parameters: result.parameters,
        };
    } else if (consumed === segments.length && (!index || !parts.length))
      return { elements: [element], parameters: nextParameters };
  }
  return undefined;
}

export function Routes({ children }: { children: ReactNode }) {
  const path = useContext(LocationContext);
  const match = matchRoutes(children, path.split("/").filter(Boolean));
  if (!match) return null;
  let rendered: ReactNode = null;
  for (let i = match.elements.length - 1; i >= 0; i--)
    rendered = (
      <OutletContext.Provider value={rendered}>
        {match.elements[i]}
      </OutletContext.Provider>
    );
  return (
    <ParametersContext.Provider value={match.parameters}>
      {rendered}
    </ParametersContext.Provider>
  );
}
