import type React from "react";

export function Logo(): React.JSX.Element {
  return <svg className="brand-mark" viewBox="0 0 200 200" role="img" aria-label="X-wing logo">
    <rect x="6" y="6" width="188" height="188" rx="36" />
    <g fill="none" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="71,78 23,48 15,100 23,152 71,122" /><polyline points="71,78 30,100 71,122" />
      <polygon points="129,78 177,48 185,100 177,152 129,122" /><polyline points="129,78 170,100 129,122" />
      <path d="m71 78 15 8m-15 36 15-8m43-36-15 8m15 36-15-8" />
      <circle cx="100" cy="100" r="20" /><circle cx="100" cy="100" r="13" />
    </g><circle className="brand-core" cx="100" cy="100" r="4.5" />
  </svg>;
}
